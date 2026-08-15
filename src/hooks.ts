/**
 * Lifecycle hook handlers. `before_prompt_build` → auto-recall context;
 * `agent_end` / `session_end` / `before_compaction` → session-digest capture.
 */
import { type HookAgentCtx, type SessionCapture, isInteractiveTrigger } from "./capture.js"
import type { DexiApi } from "./client.js"
import type { DexiConfig } from "./config.js"
import { log } from "./logger.js"
import { buildRecallContext } from "./recall.js"
import { isTrivialPrompt, stripInboundMetadata } from "./text.js"

const SKIPPED_PROVIDERS = new Set(["exec-event", "cron-event", "heartbeat"])

export function buildRecallHandler(api: DexiApi, cfg: DexiConfig) {
	return async (
		event: { prompt?: string; messages?: unknown[] },
		ctx: HookAgentCtx = {},
	): Promise<{ prependContext: string } | undefined> => {
		if (!cfg.autoRecall) return undefined
		if (!isInteractiveTrigger(ctx.trigger)) return undefined
		if (ctx.messageProvider && SKIPPED_PROVIDERS.has(ctx.messageProvider)) return undefined
		if (!api.isConnected()) return undefined
		const prompt = stripInboundMetadata(event.prompt ?? "")
		if (prompt.length < 5 || isTrivialPrompt(prompt)) return undefined
		try {
			const context = await withTimeout(buildRecallContext(api, cfg, prompt), cfg.recallTimeoutMs + 500)
			if (!context) return undefined
			log.debug(`recall: injecting ${context.length} chars`)
			return { prependContext: context }
		} catch (err) {
			log.debug(`recall skipped (${err instanceof Error ? err.message : String(err)})`)
			return undefined
		}
	}
}

export function buildAgentEndHandler(capture: SessionCapture) {
	return async (event: { success?: boolean; messages?: unknown[] }, ctx: HookAgentCtx = {}): Promise<void> => {
		try {
			capture.recordFromAgentEnd(event, ctx)
		} catch (err) {
			log.debug(`capture skipped (${err instanceof Error ? err.message : String(err)})`)
		}
	}
}

export function buildSessionEndHandler(capture: SessionCapture) {
	return async (
		event: { reason?: string; sessionKey?: string; sessionId?: string },
		ctx: HookAgentCtx = {},
	): Promise<void> => {
		if (!capture.enabled) return
		try {
			await capture.onSessionEnd(event as Parameters<SessionCapture["onSessionEnd"]>[0], ctx)
		} catch (err) {
			log.debug(`digest on session_end failed (${err instanceof Error ? err.message : String(err)})`)
		}
	}
}

export function buildBeforeCompactionHandler(capture: SessionCapture) {
	return async (_event: unknown, ctx: HookAgentCtx = {}): Promise<void> => {
		if (!capture.enabled) return
		try {
			await capture.onBeforeCompaction(ctx)
		} catch (err) {
			log.debug(`digest before compaction failed (${err instanceof Error ? err.message : String(err)})`)
		}
	}
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
		t.unref?.()
		p.then(
			(v) => (clearTimeout(t), resolve(v)),
			(e) => (clearTimeout(t), reject(e)),
		)
	})
}
