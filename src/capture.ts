/**
 * Session digest capture (opt-in via `sessionDigest`). No network on the turn
 * path: `agent_end` only buffers the last user/assistant exchange per session
 * key. A digest note is written to Dexi at the first of: session end (/new,
 * /reset, idle/daily rotation, delete), before compaction (buffer kept), the
 * idle timer (`digestIdleMinutes`), `/dexi-digest`, or plugin shutdown — and
 * later flushes *append* to the same note instead of creating another.
 *
 * Deliberately not done: a note per turn, mirroring transcripts, LLM-written
 * summaries. Dexi is the user's notes app; the agent is a reader and an
 * occasional, deliberate writer.
 */
import { type DexiApi, dexi } from "./client.js"
import type { DexiConfig } from "./config.js"
import { type Turn, buildDigest, buildDigestAppend } from "./digest.js"
import { type DigestStateStore, MemoryDigestStateStore } from "./digest-state.js"
import { log } from "./logger.js"
import { clean, messageText } from "./text.js"

const SKIPPED_PROVIDERS = new Set(["exec-event", "cron-event", "heartbeat"])
const INTERACTIVE_TRIGGERS = new Set(["user", "manual"])
const MAX_BUFFERED_TURNS = 60
const KEEP_HEAD_TURNS = 12
const MAX_FLUSH_ATTEMPTS = 3

export type SessionEndReason =
	| "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "shutdown" | "restart" | "unknown"

type SessionEntry = {
	turns: Turn[]
	digestNoteId?: string
	flushedCount: number
	attempts: number
	lastActivity: number
	channel?: string
	timer?: NodeJS.Timeout
	inflight?: Promise<void>
}

export type HookAgentCtx = {
	trigger?: string
	messageProvider?: string
	sessionKey?: string
	sessionId?: string
	channel?: string
}

export function isInteractiveTrigger(trigger: string | undefined): boolean {
	return !trigger || INTERACTIVE_TRIGGERS.has(trigger)
}

/** Subagent / cron / ACP session keys — never digest those. */
export function isBackgroundSessionKey(sessionKey: string | undefined): boolean {
	if (!sessionKey) return false
	const k = sessionKey.toLowerCase()
	return /(^|:)(subagent|cron|acp):/.test(k)
}

/** Extract the last user turn and the assistant text that followed it. */
export function lastExchange(messages: unknown[]): Turn | null {
	let lastUserIdx = -1
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messageText(messages[i])
		if (m?.role === "user") {
			lastUserIdx = i
			break
		}
	}
	if (lastUserIdx < 0) return null
	const user = messageText(messages[lastUserIdx])?.text ?? ""
	const assistantParts: string[] = []
	for (const m of messages.slice(lastUserIdx + 1)) {
		const t = messageText(m)
		if (t?.role === "assistant") assistantParts.push(t.text)
	}
	const turn = { user: clean(user), assistant: clean(assistantParts.join("\n")) }
	return turn.user || turn.assistant ? turn : null
}

export class SessionCapture {
	private readonly sessions = new Map<string, SessionEntry>()
	private stopped = false

	constructor(
		private readonly api: DexiApi,
		private readonly cfg: DexiConfig,
		private readonly state: DigestStateStore = new MemoryDigestStateStore(),
		private readonly now: () => number = () => Date.now(),
	) {}

	get enabled(): boolean {
		return this.cfg.sessionDigest && !this.cfg.readOnly
	}

	/** For tests / status. */
	inspect(sessionKey: string): { turns: number; flushed: number; noteId?: string } | undefined {
		const e = this.sessions.get(sessionKey)
		return e ? { turns: e.turns.length, flushed: e.flushedCount, noteId: e.digestNoteId } : undefined
	}

	keyFor(ctx: HookAgentCtx): string {
		return ctx.sessionKey || ctx.sessionId || "default"
	}

	/** agent_end handler body — buffer only. */
	recordFromAgentEnd(event: { success?: boolean; messages?: unknown[] }, ctx: HookAgentCtx): boolean {
		if (!this.enabled || this.stopped) return false
		if (!isInteractiveTrigger(ctx.trigger)) return false
		if (ctx.messageProvider && SKIPPED_PROVIDERS.has(ctx.messageProvider)) return false
		if (isBackgroundSessionKey(ctx.sessionKey)) return false
		if (event.success === false || !Array.isArray(event.messages) || event.messages.length === 0) return false
		const turn = lastExchange(event.messages)
		if (!turn) return false
		this.recordTurn(this.keyFor(ctx), turn, ctx.channel ?? ctx.messageProvider)
		return true
	}

	recordTurn(sessionKey: string, turn: Turn, channel?: string): void {
		if (!this.enabled || this.stopped) return
		let e = this.sessions.get(sessionKey)
		if (!e) {
			// A digest note may already exist for this conversation (gateway
			// restart, one-shot CLI runs) — keep appending to it.
			const persisted = this.safeGetState(sessionKey)
			e = { turns: [], flushedCount: 0, attempts: 0, lastActivity: this.now(), channel, digestNoteId: persisted?.noteId }
			this.sessions.set(sessionKey, e)
		}
		e.turns.push(turn)
		if (e.turns.length > MAX_BUFFERED_TURNS) {
			// Keep the head (what the digest lists) and the tail (last answer).
			e.turns.splice(KEEP_HEAD_TURNS, 1)
			if (e.flushedCount > KEEP_HEAD_TURNS) e.flushedCount -= 1
		}
		e.lastActivity = this.now()
		e.channel = e.channel ?? channel
		this.armIdleTimer(sessionKey, e)
	}

	private armIdleTimer(sessionKey: string, e: SessionEntry): void {
		if (e.timer) clearTimeout(e.timer)
		const ms = Math.max(1, this.cfg.digestIdleMinutes) * 60_000
		e.timer = setTimeout(() => {
			e.timer = undefined
			void this.flush(sessionKey, { keepBuffer: true, reason: "idle-timer" })
		}, ms)
		e.timer.unref?.()
	}

	/** session_end handler body. */
	async onSessionEnd(event: { reason?: SessionEndReason; sessionKey?: string; sessionId?: string }, ctx: HookAgentCtx): Promise<void> {
		const key = event.sessionKey || ctx.sessionKey || event.sessionId || ctx.sessionId || "default"
		const reason = event.reason ?? "unknown"
		switch (reason) {
			case "new":
			case "reset":
			case "idle":
			case "daily":
			case "deleted":
				await this.flush(key, { keepBuffer: false, reason })
				this.safeDeleteState(key)
				break
			case "shutdown":
			case "restart":
				// The host drains session_end handlers on a 2 s shared budget.
				await this.flush(key, { keepBuffer: true, reason, timeoutMs: 1500 })
				break
			default:
				await this.flush(key, { keepBuffer: true, reason })
		}
	}

	async onBeforeCompaction(ctx: HookAgentCtx): Promise<void> {
		await this.flush(this.keyFor(ctx), { keepBuffer: true, reason: "compaction" })
	}

	/**
	 * Write (or extend) the digest note for one session. Idempotent per turn
	 * count: turns already flushed are never re-sent. Returns the note id when
	 * something was written.
	 */
	async flush(
		sessionKey: string,
		opts: { keepBuffer?: boolean; reason?: string; timeoutMs?: number } = {},
	): Promise<string | undefined> {
		const e = this.sessions.get(sessionKey)
		if (!e) return undefined
		if (e.inflight) await e.inflight.catch(() => {})
		const run = this.flushEntry(sessionKey, e, opts)
		e.inflight = run.then(() => undefined, () => undefined)
		try {
			return await run
		} finally {
			e.inflight = undefined
			if (!opts.keepBuffer) {
				if (e.timer) clearTimeout(e.timer)
				this.sessions.delete(sessionKey)
			}
		}
	}

	private async flushEntry(
		sessionKey: string,
		e: SessionEntry,
		opts: { reason?: string; timeoutMs?: number },
	): Promise<string | undefined> {
		if (!this.enabled) return undefined
		const pending = e.turns.slice(e.flushedCount)
		if (pending.length === 0) return e.digestNoteId
		if (e.attempts >= MAX_FLUSH_ATTEMPTS) return e.digestNoteId
		if (!this.api.isConnected()) return undefined
		const timeoutMs = opts.timeoutMs ?? this.cfg.toolTimeoutMs
		const intent = `session digest (${opts.reason ?? "flush"})`
		const total = e.turns.length
		try {
			if (!e.digestNoteId) {
				const built = buildDigest(e.turns, {
					tag: this.cfg.digestTag,
					sessionKey,
					channel: e.channel,
					now: new Date(this.now()),
				})
				if (!built) {
					e.flushedCount = total
					return undefined
				}
				const note = await dexi.createNote(this.api, built.title, built.text, { timeoutMs, intent })
				e.digestNoteId = note.id
				this.safeSetState(sessionKey, note.id, total)
				log.info(`session digest written (${sessionKey}) → ${note.url ?? note.id}`)
			} else {
				const appendText = buildDigestAppend(pending, { now: new Date(this.now()) })
				if (appendText) {
					await dexi.appendNote(this.api, e.digestNoteId, appendText, { timeoutMs, intent })
					this.safeSetState(sessionKey, e.digestNoteId, total)
					log.debug(`session digest extended (${sessionKey}, +${pending.length} turns)`)
				}
			}
			e.flushedCount = total
			e.attempts = 0
			return e.digestNoteId
		} catch (err) {
			e.attempts += 1
			log.warn(`session digest flush failed (${sessionKey}, attempt ${e.attempts})`, err)
			return e.digestNoteId
		}
	}

	private safeGetState(sessionKey: string) {
		try {
			return this.state.get(sessionKey)
		} catch {
			return undefined
		}
	}

	private safeSetState(sessionKey: string, noteId: string, flushedTurns: number): void {
		try {
			const prev = this.state.get(sessionKey)
			const nowIso = new Date(this.now()).toISOString()
			this.state.set(sessionKey, {
				noteId,
				createdAt: prev?.noteId === noteId ? prev.createdAt : nowIso,
				updatedAt: nowIso,
				flushedTurns,
			})
		} catch (err) {
			log.debug(`digest state not persisted (${err instanceof Error ? err.message : String(err)})`)
		}
	}

	private safeDeleteState(sessionKey: string): void {
		try {
			this.state.delete(sessionKey)
		} catch {
			// best effort
		}
	}

	/** Flush every session (shutdown / explicit). */
	async flushAll(opts: { keepBuffer?: boolean; reason?: string; timeoutMs?: number } = {}): Promise<void> {
		const keys = [...this.sessions.keys()]
		await Promise.all(keys.map((k) => this.flush(k, opts)))
	}

	async stop(): Promise<void> {
		this.stopped = true
		for (const e of this.sessions.values()) if (e.timer) clearTimeout(e.timer)
		await this.flushAll({ keepBuffer: false, reason: "shutdown", timeoutMs: 1500 })
	}
}
