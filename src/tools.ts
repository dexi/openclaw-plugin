/**
 * The compact `dexi_*` agent tools. Each forwards to the Dexi MCP tool of the
 * same purpose (backend/app/mcp/tools.py) via the typed helpers in client.ts,
 * renders a model-friendly text block, and keeps the raw items in `details`.
 * Every tool accepts an optional free-text `intent` for Dexi's aggregate
 * tool-call analytics (never read by the tool itself).
 *
 * Write tools (dexi_save / dexi_append / dexi_review_grade) are registered
 * through factories that return null when the connection is read-only, so
 * the manifest can still declare all nine names.
 */
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry"
import { type Static, type TSchema, Type } from "typebox"
import { type DexiApi, DexiToolError, type NoteItem, dexi } from "./client.js"
import type { DexiConfig } from "./config.js"
import { DexiAuthError } from "./auth/provider.js"

export const TOOL_NAMES = [
	"dexi_search",
	"dexi_get",
	"dexi_list",
	"dexi_save",
	"dexi_append",
	"dexi_tags",
	"dexi_folders",
	"dexi_reviews_due",
	"dexi_review_grade",
] as const
export const WRITE_TOOL_NAMES = new Set(["dexi_save", "dexi_append", "dexi_review_grade"])

const Intent = Type.Optional(
	Type.String({
		description:
			"One short sentence: what you are trying to accomplish with this call (for the user's aggregate tool analytics). Never changes behavior; keep personal details out.",
		maxLength: 300,
	}),
)

type TextResult<T> = { content: Array<{ type: "text"; text: string }>; details: T }

function text<T>(t: string, details: T): TextResult<T> {
	return { content: [{ type: "text", text: t }], details }
}

function fmtItem(i: NoteItem, idx: number, opts: { showBody?: boolean } = {}): string {
	const head = `${idx + 1}. ${(i.title || "(untitled)").trim()} [${i.id}]`
	const meta = [
		i.source,
		(i.tags || []).join(" ") || undefined,
		i.folder ? `folder: ${i.folder}` : undefined,
		typeof i.similarity === "number" ? `${Math.round(i.similarity * 100)}%` : undefined,
		(i as { match?: string }).match,
		i.updated ? `updated ${String(i.updated).slice(0, 10)}` : undefined,
	]
		.filter(Boolean)
		.join(" · ")
	const lines = [head + (meta ? ` (${meta})` : "")]
	if (i.url) lines.push(`   ${i.url}`)
	const body = opts.showBody && typeof i.text === "string" ? i.text : i.snippet
	if (body) lines.push(`   ${body.trim().replace(/\n/g, "\n   ")}${i.text_truncated ? "\n   […truncated]" : ""}`)
	return lines.join("\n")
}

function fmtList(items: NoteItem[], opts: { showBody?: boolean; total?: number; label?: string } = {}): string {
	if (items.length === 0) return `No ${opts.label ?? "notes"} found.`
	const head = `${opts.total !== undefined ? `${opts.total} ${opts.label ?? "notes"} total, showing ${items.length}` : `${items.length} ${opts.label ?? "notes"}`}:`
	return [head, "", ...items.map((it, i) => fmtItem(it, i, opts))].join("\n\n")
}

function wrap<S extends TSchema, D>(
	name: string,
	label: string,
	description: string,
	parameters: S,
	run: (params: Static<S>, signal?: AbortSignal) => Promise<TextResult<D>>,
): AnyAgentTool {
	return {
		name,
		label,
		description,
		parameters,
		async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
			try {
				return await run(params as Static<S>, signal)
			} catch (err) {
				if (err instanceof DexiAuthError) throw new Error(err.message)
				if (err instanceof DexiToolError) throw new Error(`Dexi: ${err.message}`)
				throw err
			}
		},
	} as unknown as AnyAgentTool
}

export function buildTools(api: DexiApi, cfg: DexiConfig): Record<(typeof TOOL_NAMES)[number], AnyAgentTool> {
	const call = (intent?: string) => ({ timeoutMs: cfg.toolTimeoutMs, intent })

	const dexi_search = wrap(
		"dexi_search",
		"Dexi: search notes",
		"Search the user's Dexi notes library (typed notes, clipped web pages, emailed articles, RSS entries). mode=hybrid (default) merges semantic + keyword hits; full_text=true returns bodies (max 10). Cite results by title with their url.",
		Type.Object({
			query: Type.String({ description: "What to look for — a question, topic, phrase, or #hashtag", minLength: 1, maxLength: 500 }),
			mode: Type.Optional(Type.Union([Type.Literal("hybrid"), Type.Literal("semantic"), Type.Literal("keyword")], { description: "Default hybrid" })),
			size: Type.Optional(Type.Integer({ description: "Max results (default 10, max 50)", minimum: 1, maximum: 50 })),
			full_text: Type.Optional(Type.Boolean({ description: "Return note bodies instead of snippets (caps size at 10)" })),
			intent: Intent,
		}),
		async (p, signal) => {
			const res = await dexi.search(api, p.query, { ...call(p.intent), signal, mode: p.mode, size: p.size ?? 10, fullText: p.full_text })
			return text(fmtList(res.items, { showBody: Boolean(p.full_text) }), { items: res.items, mode: res.mode, count: res.items.length })
		},
	)

	const dexi_get = wrap(
		"dexi_get",
		"Dexi: read note",
		"Read one Dexi note in full by id (ids come from dexi_search / dexi_list / <dexi-context>).",
		Type.Object({ note_id: Type.String({ description: "Note id (UUID)" }), intent: Intent }),
		async (p, signal) => {
			const note = await dexi.getNote(api, p.note_id, { ...call(p.intent), signal })
			return text(fmtItem(note, 0, { showBody: true }), { note })
		},
	)

	const dexi_list = wrap(
		"dexi_list",
		"Dexi: list notes",
		"Browse notes by organization instead of content: filter by source, #tag, folder name, period (today/yesterday/week) or since (ISO 8601 timestamp), sorted by created or updated. Paginated.",
		Type.Object({
			source: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("bookmark"), Type.Literal("email"), Type.Literal("feed"), Type.Literal("note")])),
			tag: Type.Optional(Type.String({ description: "Hashtag with or without #" })),
			folder: Type.Optional(Type.String({ description: 'Folder name (case-insensitive) or "unfiled"' })),
			period: Type.Optional(Type.Union([Type.Literal("today"), Type.Literal("yesterday"), Type.Literal("week")])),
			since: Type.Optional(Type.String({ description: "ISO 8601 timestamp; only notes created/updated after it" })),
			sort: Type.Optional(Type.Union([Type.Literal("created"), Type.Literal("updated")])),
			page: Type.Optional(Type.Integer({ minimum: 1 })),
			size: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
			full_text: Type.Optional(Type.Boolean({ description: "Return bodies (caps size at 10)" })),
			intent: Intent,
		}),
		async (p, signal) => {
			const res = await dexi.listNotes(api, { ...p, fullText: p.full_text }, { ...call(p.intent), signal })
			return text(fmtList(res.items, { showBody: Boolean(p.full_text), total: res.total }), { items: res.items, total: res.total, page: res.page })
		},
	)

	const dexi_save = wrap(
		"dexi_save",
		"Dexi: save note",
		"Create a note in the user's Dexi library. Distill, don't dump: a short specific noun-phrase title, plain text body, 1-3 existing #hashtags inline (check dexi_tags), [[Wiki Links]] welcome. Search first — prefer dexi_append to an existing match over a near-duplicate.",
		Type.Object({
			title: Type.String({ description: "Short noun-phrase title", maxLength: 500 }),
			text: Type.String({ description: "Plain-text body; #hashtags inline become tags" }),
			intent: Intent,
		}),
		async (p, signal) => {
			const note = await dexi.createNote(api, p.title, p.text, { ...call(p.intent), signal })
			return text(`Saved "${note.title ?? p.title}" — ${note.url ?? note.id}`, { note })
		},
	)

	const dexi_append = wrap(
		"dexi_append",
		"Dexi: append to note",
		"Append plain text to an existing Dexi note (keeps its title, tags, and formatting).",
		Type.Object({ note_id: Type.String(), text: Type.String({ description: "Text to add at the end" }), intent: Intent }),
		async (p, signal) => {
			const note = await dexi.appendNote(api, p.note_id, p.text, { ...call(p.intent), signal })
			return text(`Appended to "${note.title ?? p.note_id}" — ${note.url ?? note.id}`, { note })
		},
	)

	const dexi_tags = wrap(
		"dexi_tags",
		"Dexi: list tags",
		"The user's existing #hashtags with counts — reuse this vocabulary when saving.",
		Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), intent: Intent }),
		async (p, signal) => {
			const tags = await dexi.listTags(api, p.limit ?? 50, { ...call(p.intent), signal })
			return text(tags.length ? tags.map((t) => `${t.tag} (${t.count})`).join("\n") : "No tags yet.", { tags })
		},
	)

	const dexi_folders = wrap(
		"dexi_folders",
		"Dexi: list folders",
		"The user's folders with note counts, plus how many notes are unfiled. Use folder names with dexi_list.",
		Type.Object({ intent: Intent }),
		async (p, signal) => {
			const f = await dexi.listFolders(api, { ...call(p.intent), signal })
			const lines = f.folders.map((x) => `${x.name} (${x.note_count})`)
			if (f.unfiled_count !== undefined) lines.push(`(unfiled: ${f.unfiled_count})`)
			return text(lines.length ? lines.join("\n") : "No folders.", f)
		},
	)

	const dexi_reviews_due = wrap(
		"dexi_reviews_due",
		"Dexi: due reviews",
		"Spaced-repetition cards due now (notes carrying the user's review deck tag). Quiz question-first: show the title, wait, then reveal and grade with dexi_review_grade.",
		Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), intent: Intent }),
		async (p, signal) => {
			const r = await dexi.dueReviews(api, p.limit ?? 10, { ...call(p.intent), signal })
			const lines = r.items.map((it, i) => `${i + 1}. ${it.title || "(untitled)"} [${it.id}]${it.is_new ? " (new)" : ""}`)
			const head = r.due_count !== undefined ? `${r.due_count} due` : `${r.items.length} due`
			return text(lines.length ? [head, ...lines].join("\n") : "Nothing due for review.", r)
		},
	)

	const dexi_review_grade = wrap(
		"dexi_review_grade",
		"Dexi: grade review",
		"Record the user's self-assessment for a due card: 1=Again, 2=Hard, 3=Good, 4=Easy. Returns the next due date.",
		Type.Object({ note_id: Type.String(), grade: Type.Integer({ minimum: 1, maximum: 4 }), intent: Intent }),
		async (p, signal) => {
			const r = await dexi.gradeReview(api, p.note_id, p.grade, { ...call(p.intent), signal })
			const due = (r as { due_at?: string }).due_at
			const days = (r as { interval_days?: number }).interval_days
			return text(`Graded ${p.grade}/4${days !== undefined ? ` — next in ${days} day${days === 1 ? "" : "s"}` : ""}${due ? ` (${due})` : ""}`, r)
		},
	)

	return { dexi_search, dexi_get, dexi_list, dexi_save, dexi_append, dexi_tags, dexi_folders, dexi_reviews_due, dexi_review_grade }
}

/** Register all nine tools; write tools become no-ops (null factory) when read-only. */
export function registerTools(api: OpenClawPluginApi, client: DexiApi, cfg: DexiConfig): void {
	const tools = buildTools(client, cfg)
	for (const name of TOOL_NAMES) {
		const tool = tools[name]
		if (WRITE_TOOL_NAMES.has(name)) {
			api.registerTool(() => (cfg.readOnly ? null : tool), { name })
		} else {
			api.registerTool(tool, { name })
		}
	}
}
