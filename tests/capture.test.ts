import { describe, expect, it } from "vitest"
import { SessionCapture, isBackgroundSessionKey, lastExchange } from "../src/capture.js"
import { MemoryDigestStateStore } from "../src/digest-state.js"
import { buildAgentEndHandler, buildBeforeCompactionHandler, buildSessionEndHandler } from "../src/hooks.js"
import { FakeDexiClient, cfg, defaultHandler } from "./helpers.js"

const msgs = (...pairs: Array<[string, string]>) =>
	pairs.flatMap(([u, a]) => [
		{ role: "user", content: u },
		{ role: "assistant", content: [{ type: "text", text: a }] },
	])

function make(overrides = {}, handler = defaultHandler) {
	const api = new FakeDexiClient(handler)
	const state = new MemoryDigestStateStore()
	let t = 1_000_000
	const capture = new SessionCapture(api, cfg({ sessionDigest: true, ...overrides }), state, () => (t += 1000))
	return { api, capture, state }
}

describe("lastExchange / isBackgroundSessionKey", () => {
	it("takes the last user message and the assistant text after it", () => {
		expect(lastExchange(msgs(["q1", "a1"], ["q2", "a2"]))).toEqual({ user: "q2", assistant: "a2" })
		expect(lastExchange([{ role: "assistant", content: "only" }])).toBeNull()
		expect(lastExchange([])).toBeNull()
	})
	it("flags subagent/cron keys", () => {
		expect(isBackgroundSessionKey("agent:main:subagent:abc")).toBe(true)
		expect(isBackgroundSessionKey("subagent:abc")).toBe(true)
		expect(isBackgroundSessionKey("agent:main:cron:job")).toBe(true)
		expect(isBackgroundSessionKey("agent:main:main")).toBe(false)
		expect(isBackgroundSessionKey(undefined)).toBe(false)
	})
})

describe("SessionCapture gating (agent_end)", () => {
	it("buffers interactive turns only — never touches the network", () => {
		const { api, capture } = make()
		const ev = { success: true, messages: msgs(["hello there friend", "hi"]) }
		expect(capture.recordFromAgentEnd(ev, { trigger: "user", sessionKey: "s1" })).toBe(true)
		expect(capture.recordFromAgentEnd(ev, { trigger: "heartbeat", sessionKey: "s1" })).toBe(false)
		expect(capture.recordFromAgentEnd(ev, { trigger: "user", messageProvider: "cron-event", sessionKey: "s1" })).toBe(false)
		expect(capture.recordFromAgentEnd(ev, { trigger: "user", sessionKey: "agent:main:subagent:x" })).toBe(false)
		expect(capture.recordFromAgentEnd({ success: false, messages: ev.messages }, { trigger: "user", sessionKey: "s1" })).toBe(false)
		expect(capture.recordFromAgentEnd({ success: true, messages: [] }, { trigger: "user", sessionKey: "s1" })).toBe(false)
		expect(capture.inspect("s1")).toEqual({ turns: 1, flushed: 0, noteId: undefined })
		expect(api.calls).toHaveLength(0)
	})
	it("is inert when digests are off or the connection is read-only", () => {
		const off = make({ sessionDigest: false })
		expect(off.capture.recordFromAgentEnd({ success: true, messages: msgs(["q", "a"]) }, { sessionKey: "s" })).toBe(false)
		const ro = make({ readOnly: true })
		expect(ro.capture.enabled).toBe(false)
		expect(ro.capture.recordFromAgentEnd({ success: true, messages: msgs(["q", "a"]) }, { sessionKey: "s" })).toBe(false)
	})
})

describe("SessionCapture flush", () => {
	it("creates a note once, then appends only new turns (idempotent per turn count)", async () => {
		const { api, capture, state } = make()
		capture.recordTurn("s1", { user: "first question", assistant: "first answer" }, "telegram")
		const id1 = await capture.flush("s1", { keepBuffer: true, reason: "compaction" })
		expect(id1).toBe("new-1")
		expect(api.callsTo("create_note")).toHaveLength(1)
		const created = api.callsTo("create_note")[0]!.args
		expect(created.title).toMatch(/^OpenClaw session \d{4}-\d{2}-\d{2} — first question$/)
		expect(created.text).toContain("#openclaw Session digest written by OpenClaw (telegram)")
		expect(created.text).toContain("Session: s1")
		expect(created.intent).toBe("session digest (compaction)")
		expect(state.get("s1")?.noteId).toBe("new-1")

		// Nothing new → no network.
		await capture.flush("s1", { keepBuffer: true })
		expect(api.calls).toHaveLength(1)

		capture.recordTurn("s1", { user: "second question", assistant: "second answer" })
		await capture.flush("s1", { keepBuffer: true, reason: "idle-timer" })
		expect(api.callsTo("update_note")).toHaveLength(1)
		expect(api.callsTo("update_note")[0]!.args).toMatchObject({ note_id: "new-1", mode: "append" })
		expect(api.callsTo("update_note")[0]!.args.text).toContain("- second question")
		expect(api.callsTo("update_note")[0]!.args.text).not.toContain("first question")
	})

	it("session_end new/reset ends the session: flush, drop buffer and persisted mapping", async () => {
		const { api, capture, state } = make()
		capture.recordTurn("s1", { user: "q", assistant: "a" })
		await buildSessionEndHandler(capture)({ reason: "new", sessionKey: "s1", sessionId: "x" }, { sessionKey: "s1" })
		expect(api.callsTo("create_note")).toHaveLength(1)
		expect(capture.inspect("s1")).toBeUndefined()
		expect(state.get("s1")).toBeUndefined()
		// A later turn under the same key starts a fresh note.
		capture.recordTurn("s1", { user: "new conversation", assistant: "a" })
		await capture.flush("s1")
		expect(api.callsTo("create_note")).toHaveLength(2)
	})

	it("compaction / before_compaction keeps the buffer; shutdown uses a short timeout", async () => {
		const { api, capture } = make()
		capture.recordTurn("s1", { user: "q", assistant: "a" })
		await buildBeforeCompactionHandler(capture)({}, { sessionKey: "s1" })
		expect(capture.inspect("s1")?.flushed).toBe(1)
		capture.recordTurn("s1", { user: "q2", assistant: "a2" })
		await buildSessionEndHandler(capture)({ reason: "shutdown", sessionKey: "s1" }, { sessionKey: "s1" })
		expect(api.callsTo("update_note")[0]!.opts?.timeoutMs).toBe(1500)
		expect(capture.inspect("s1")?.turns).toBe(2)
	})

	it("reuses a persisted digest note after a restart (append instead of create)", async () => {
		const api = new FakeDexiClient()
		const state = new MemoryDigestStateStore()
		state.set("s9", { noteId: "old-note", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" })
		const capture = new SessionCapture(api, cfg({ sessionDigest: true }), state)
		capture.recordTurn("s9", { user: "after restart", assistant: "yes" })
		await capture.flush("s9", { keepBuffer: true })
		expect(api.callsTo("create_note")).toHaveLength(0)
		expect(api.callsTo("update_note")[0]!.args.note_id).toBe("old-note")
	})

	it("retries failed writes on the next flush, then gives up after 3 attempts; unauthenticated → no write", async () => {
		let fail = true
		const { api, capture } = make({}, (n, a) => (fail && n === "create_note" ? new Error("503") : defaultHandler(n, a)))
		capture.recordTurn("s1", { user: "q", assistant: "a" })
		expect(await capture.flush("s1", { keepBuffer: true })).toBeUndefined()
		expect(capture.inspect("s1")?.flushed).toBe(0)
		fail = false
		expect(await capture.flush("s1", { keepBuffer: true })).toBe("new-1")
		fail = true
		const c2 = make({}, () => new Error("down"))
		c2.capture.recordTurn("s2", { user: "q", assistant: "a" })
		for (let i = 0; i < 5; i++) await c2.capture.flush("s2", { keepBuffer: true })
		expect(c2.api.callsTo("create_note")).toHaveLength(3)
		const c3 = make()
		c3.api.connected = false
		c3.capture.recordTurn("s3", { user: "q", assistant: "a" })
		await c3.capture.flush("s3")
		expect(c3.api.calls).toHaveLength(0)
	})

	it("agent_end handler feeds the buffer via the hook contract and stop() flushes everything", async () => {
		const { api, capture } = make()
		await buildAgentEndHandler(capture)({ success: true, messages: msgs(["a question here", "an answer"]) }, { trigger: "user", sessionKey: "sA" })
		await buildAgentEndHandler(capture)({ success: true, messages: msgs(["another question", "answer"]) }, { trigger: "user", sessionKey: "sB" })
		await capture.stop()
		expect(api.callsTo("create_note")).toHaveLength(2)
		expect(capture.inspect("sA")).toBeUndefined()
	})
})
