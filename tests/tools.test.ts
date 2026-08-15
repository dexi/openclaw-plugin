import { describe, expect, it } from "vitest"
import { DexiAuthError } from "../src/auth/provider.js"
import { dexi } from "../src/client.js"
import { TOOL_NAMES, WRITE_TOOL_NAMES, buildTools, registerTools } from "../src/tools.js"
import { FakeDexiClient, cfg, defaultHandler } from "./helpers.js"

type Tool = {
	name: string
	parameters: { properties: Record<string, unknown> }
	execute: (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>
}

describe("dexi.* helpers (wire shapes)", () => {
	it("hybrid search merges semantic-first with keyword-only tail and labels matches", async () => {
		const api = new FakeDexiClient()
		const res = await dexi.search(api, "pgvector", { size: 10 })
		expect(res.items.map((i) => [i.id, i.match])).toEqual([
			["a", "semantic"],
			["b", "both"],
			["c", "semantic"],
			["d", "keyword"],
		])
		expect(res.items[0]!.url).toBe("https://app.dexi.net/dashboard/notes/a")
		expect(api.calls.map((c) => c.name)).toEqual(["semantic_search", "search_notes"])
	})
	it("routes by mode and sends full_text only when true", async () => {
		const api = new FakeDexiClient()
		await dexi.search(api, "q", { mode: "keyword" })
		expect(api.calls.map((c) => c.name)).toEqual(["search_notes"])
		expect(api.calls[0]!.args).not.toHaveProperty("full_text")
		api.calls.length = 0
		await dexi.search(api, "q", { mode: "semantic", fullText: true, size: 3 })
		expect(api.calls.map((c) => c.name)).toEqual(["semantic_search"])
		expect(api.calls[0]!.args).toMatchObject({ full_text: true, size: 3 })
	})
	it("list_notes drops undefined filters", async () => {
		const api = new FakeDexiClient()
		await dexi.listNotes(api, { tag: "#x", since: undefined, page: 2 })
		expect(api.calls[0]!.args).toEqual({ tag: "#x", page: 2 })
	})
	it("append uses update_note mode=append", async () => {
		const api = new FakeDexiClient()
		await dexi.appendNote(api, "n1", "more")
		expect(api.calls[0]).toMatchObject({ name: "update_note", args: { note_id: "n1", text: "more", mode: "append" } })
	})
})

describe("buildTools", () => {
	const api = new FakeDexiClient()
	const tools = buildTools(api, cfg()) as unknown as Record<string, Tool>

	it("defines all nine dexi_* tools with an intent parameter", () => {
		expect(Object.keys(tools).sort()).toEqual([...TOOL_NAMES].sort())
		for (const name of TOOL_NAMES) {
			expect(tools[name]!.name).toBe(name)
			expect(tools[name]!.parameters.properties).toHaveProperty("intent")
		}
	})

	it("dexi_search renders a numbered list with urls and keeps items in details", async () => {
		const out = await tools.dexi_search!.execute("t1", { query: "pgvector", intent: "test" })
		expect(out.content[0]!.text).toContain("1. Note a [a]")
		expect(out.content[0]!.text).toContain("https://app.dexi.net/dashboard/notes/a")
		expect((out.details as { count: number }).count).toBe(4)
		expect(api.calls.at(-1)!.args.intent).toBe("test")
	})

	it("dexi_save / dexi_get / dexi_tags / dexi_folders / reviews", async () => {
		const save = await tools.dexi_save!.execute("t", { title: "T", text: "body #openclaw" })
		expect(save.content[0]!.text).toContain("Saved")
		expect(save.content[0]!.text).toContain("/notes/new-1")
		const get = await tools.dexi_get!.execute("t", { note_id: "abc" })
		expect(get.content[0]!.text).toContain("Full text of abc")
		const tags = await tools.dexi_tags!.execute("t", {})
		expect(tags.content[0]!.text).toBe("#openclaw (4)\n#t1 (2)")
		const folders = await tools.dexi_folders!.execute("t", {})
		expect(folders.content[0]!.text).toBe("Work (3)\n(unfiled: 7)")
		const due = await tools.dexi_reviews_due!.execute("t", {})
		expect(due.content[0]!.text).toContain("1 due")
		const graded = await tools.dexi_review_grade!.execute("t", { note_id: "r1", grade: 3 })
		expect(graded.content[0]!.text).toContain("next in 6 days")
	})

	it("surfaces auth problems as a clear error", async () => {
		const bad = new FakeDexiClient(() => new DexiAuthError())
		const t = buildTools(bad, cfg()) as unknown as Record<string, Tool>
		await expect(t.dexi_search!.execute("t", { query: "x" })).rejects.toThrow(/openclaw dexi login/)
	})

	it("relays Dexi tool errors (e.g. note limit) verbatim", async () => {
		const { DexiToolError } = await import("../src/client.js")
		const bad = new FakeDexiClient((n, a) => (n === "create_note" ? new DexiToolError("Note limit reached (1000/1000)") : defaultHandler(n, a)))
		const t = buildTools(bad, cfg()) as unknown as Record<string, Tool>
		await expect(t.dexi_save!.execute("t", { title: "x", text: "y" })).rejects.toThrow(/Note limit reached/)
	})
})

describe("registerTools", () => {
	function fakeApi() {
		const registered: Array<{ tool: unknown; name: string }> = []
		return {
			registered,
			registerTool: (tool: unknown, opts: { name?: string }) => registered.push({ tool, name: opts.name ?? "?" }),
		}
	}
	it("registers all nine names, write tools through factories", () => {
		const a = fakeApi()
		registerTools(a as never, new FakeDexiClient(), cfg())
		expect(a.registered.map((r) => r.name)).toEqual([...TOOL_NAMES])
		for (const r of a.registered) {
			if (WRITE_TOOL_NAMES.has(r.name)) {
				expect(typeof r.tool).toBe("function")
				expect((r.tool as () => unknown)()).not.toBeNull()
			} else expect(typeof r.tool).toBe("object")
		}
	})
	it("read-only: write-tool factories return null", () => {
		const a = fakeApi()
		registerTools(a as never, new FakeDexiClient(), cfg({ readOnly: true }))
		for (const r of a.registered) {
			if (WRITE_TOOL_NAMES.has(r.name)) expect((r.tool as () => unknown)()).toBeNull()
		}
	})
})
