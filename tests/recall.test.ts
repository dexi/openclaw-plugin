import { describe, expect, it } from "vitest"
import { buildRecallHandler } from "../src/hooks.js"
import { buildPromptSection } from "../src/prompt.js"
import { RECALL_INTENT, buildRecallContext, formatRecallContext, recallItems } from "../src/recall.js"
import { FakeDexiClient, cfg, defaultHandler, note } from "./helpers.js"

describe("recallItems", () => {
	it("filters by the similarity floor and caps at recallResults", async () => {
		const api = new FakeDexiClient()
		const items = await recallItems(api, cfg({ recallResults: 5, recallMinSimilarity: 0.55 }), "tell me about pgvector")
		expect(items.map((i) => i.id)).toEqual(["a", "b"]) // c is 0.3
		const call = api.calls[0]!
		expect(call.name).toBe("semantic_search")
		expect(call.args).toMatchObject({ query: "tell me about pgvector", size: 5, intent: RECALL_INTENT })
		expect(call.args).not.toHaveProperty("full_text")
		expect(call.opts?.timeoutMs).toBe(2500)
		expect(api.callsTo("search_notes")).toHaveLength(0)
	})

	it("adds a keyword pass for #hashtags and quoted phrases, deduped by id", async () => {
		const api = new FakeDexiClient()
		const items = await recallItems(api, cfg(), 'anything about #pgvector or "exact phrase"')
		expect(api.callsTo("search_notes")).toHaveLength(1)
		expect(items.map((i) => i.id)).toEqual(["a", "b", "d"])
	})

	it("truncates the query to 500 chars", async () => {
		const api = new FakeDexiClient()
		await recallItems(api, cfg(), "x".repeat(700))
		expect((api.calls[0]!.args.query as string).length).toBe(500)
	})

	it("is best-effort: semantic failure → empty, keyword failure ignored", async () => {
		const failing = new FakeDexiClient(() => new Error("boom"))
		expect(await recallItems(failing, cfg(), "what about pgvector")).toEqual([])
		const kwFails = new FakeDexiClient((n, a) => (n === "search_notes" ? new Error("nope") : defaultHandler(n, a)))
		expect((await recallItems(kwFails, cfg(), "#tag question")).map((i) => i.id)).toEqual(["a", "b"])
	})
})

describe("formatRecallContext", () => {
	it("renders titles + snippets inside <dexi-context>, never bodies", () => {
		const out = formatRecallContext([note("a", { snippet: "line one\nline two", tags: ["#x", "#y"], source: "bookmark", text: "SECRET BODY" })])!
		expect(out.startsWith("<dexi-context>")).toBe(true)
		expect(out.endsWith("</dexi-context>")).toBe(true)
		expect(out).toContain("- Note a [a] (bookmark · #x #y): line one line two")
		expect(out).not.toContain("SECRET BODY")
		expect(formatRecallContext([])).toBeNull()
	})
	it("handles missing title/meta", () => {
		const out = formatRecallContext([{ id: "z" }])!
		expect(out).toContain("- (untitled) [z]")
	})
})

describe("buildRecallHandler (before_prompt_build)", () => {
	it("injects prependContext for a real user prompt", async () => {
		const api = new FakeDexiClient()
		const h = buildRecallHandler(api, cfg())
		const res = await h({ prompt: "what did I save about pgvector?" }, { trigger: "user" })
		expect(res?.prependContext).toContain("<dexi-context>")
	})
	it("skips trivial prompts, non-user triggers, system providers, disabled recall, and unauthenticated state", async () => {
		const api = new FakeDexiClient()
		expect(await buildRecallHandler(api, cfg())({ prompt: "hi" }, { trigger: "user" })).toBeUndefined()
		expect(await buildRecallHandler(api, cfg())({ prompt: "what did I save about pgvector?" }, { trigger: "heartbeat" })).toBeUndefined()
		expect(await buildRecallHandler(api, cfg())({ prompt: "what did I save about pgvector?" }, { trigger: "user", messageProvider: "cron-event" })).toBeUndefined()
		expect(await buildRecallHandler(api, cfg({ autoRecall: false }))({ prompt: "what did I save about pgvector?" }, { trigger: "user" })).toBeUndefined()
		api.connected = false
		expect(await buildRecallHandler(api, cfg())({ prompt: "what did I save about pgvector?" }, { trigger: "user" })).toBeUndefined()
		expect(api.calls).toHaveLength(0)
	})
	it("strips the inbound metadata envelope before searching", async () => {
		const api = new FakeDexiClient()
		await buildRecallHandler(api, cfg())(
			{ prompt: "[Fri 2026-08-15 09:00 PDT] Sender (untrusted metadata):\n```json\n{}\n```\n\nwhat did I save about pgvector?" },
			{ trigger: "user" },
		)
		expect(api.calls[0]!.args.query).toBe("what did I save about pgvector?")
	})
	it("never throws when Dexi fails", async () => {
		const api = new FakeDexiClient(() => new Error("down"))
		expect(await buildRecallHandler(api, cfg())({ prompt: "what did I save about pgvector?" }, { trigger: "user" })).toBeUndefined()
	})
})

describe("buildRecallContext / buildPromptSection", () => {
	it("returns null when nothing matches", async () => {
		const api = new FakeDexiClient(() => ({ items: [] }))
		expect(await buildRecallContext(api, cfg(), "anything long enough")).toBeNull()
	})
	it("prompt section reflects read-only and digest settings", () => {
		const tools = new Set(["dexi_search", "dexi_save"])
		const rw = buildPromptSection(cfg(), { availableTools: tools }).join("\n")
		expect(rw).toContain("## Memory (Dexi)")
		expect(rw).toContain("dexi_save")
		expect(rw).not.toContain("read-only")
		const ro = buildPromptSection(cfg({ readOnly: true }), { availableTools: new Set(["dexi_search"]) }).join("\n")
		expect(ro).toContain("read-only")
		const dg = buildPromptSection(cfg({ sessionDigest: true }), { availableTools: tools }).join("\n")
		expect(dg).toContain("#openclaw digest note")
		expect(buildPromptSection(cfg(), { availableTools: new Set() })).toEqual([])
	})
})
