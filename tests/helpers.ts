import type { DexiApi, ToolCallOptions } from "../src/client.js"
import { DEFAULTS, type DexiConfig } from "../src/config.js"

export type Call = { name: string; args: Record<string, unknown>; opts?: ToolCallOptions }

/** Records every call; `handler` returns canned structured results (or throws). */
export class FakeDexiClient implements DexiApi {
	readonly mcpUrl = "https://mcp.dexi.net/mcp"
	readonly calls: Call[] = []
	connected = true
	closed = 0
	constructor(
		public handler: (name: string, args: Record<string, unknown>) => Record<string, unknown> | Error = defaultHandler,
	) {}
	isConnected(): boolean {
		return this.connected
	}
	async callTool(name: string, args: Record<string, unknown>, opts?: ToolCallOptions): Promise<Record<string, unknown>> {
		const clean: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) clean[k] = v
		if (opts?.intent && clean.intent === undefined) clean.intent = opts.intent
		this.calls.push({ name, args: clean, opts })
		const res = this.handler(name, clean)
		if (res instanceof Error) throw res
		return res
	}
	async close(): Promise<void> {
		this.closed += 1
	}
	callsTo(name: string): Call[] {
		return this.calls.filter((c) => c.name === name)
	}
}

export function note(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		title: `Note ${id}`,
		snippet: `Snippet for ${id}`,
		tags: ["#t1"],
		source: "note",
		created: "2026-08-01T00:00:00Z",
		updated: "2026-08-02T00:00:00Z",
		...extra,
	}
}

export function defaultHandler(name: string, args: Record<string, unknown>): Record<string, unknown> | Error {
	switch (name) {
		case "semantic_search":
			return { items: [note("a", { similarity: 0.9 }), note("b", { similarity: 0.6 }), note("c", { similarity: 0.3 })] }
		case "search_notes":
			return { items: [note("b"), note("d")], total: 2, page: 1 }
		case "list_notes":
			return { items: [note("x")], total: 1, page: args.page ?? 1 }
		case "get_note":
			return { ...note(String(args.note_id)), text: `Full text of ${args.note_id}` }
		case "create_note":
			return { id: "new-1", title: args.title, tags: ["#openclaw"] }
		case "update_note":
			return { id: args.note_id, title: `Note ${args.note_id}` }
		case "list_tags":
			return { tags: [{ tag: "#openclaw", count: 4 }, { tag: "#t1", count: 2 }] }
		case "list_folders":
			return { folders: [{ name: "Work", note_count: 3 }], unfiled_count: 7 }
		case "get_due_reviews":
			return { items: [{ id: "r1", title: "Card 1", text: "Body", is_new: true }], due_count: 1 }
		case "grade_review":
			return { id: args.note_id, grade: args.grade, due_at: "2026-08-20T00:00:00Z", interval_days: 6, ease_factor: 2.5, repetitions: 2 }
		default:
			return new Error(`unexpected tool ${name}`)
	}
}

export function cfg(overrides: Partial<DexiConfig> = {}): DexiConfig {
	return { ...DEFAULTS, ...overrides }
}
