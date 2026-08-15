/**
 * Auto-recall: before a turn, semantic-search the user's message (plus a
 * cheap keyword pass when it carries a #hashtag or "quoted phrase") and
 * inject titles + snippets as a `<dexi-context>` block. Never full bodies —
 * the model calls dexi_get / full_text when it wants one. Best-effort: any
 * failure or timeout injects nothing. Port of hermes provider._recall.
 */
import { type DexiApi, type NoteItem, dexi } from "./client.js"
import type { DexiConfig } from "./config.js"
import { log } from "./logger.js"

const HASHTAG_RE = /(?<!\w)#\w+/
const QUOTED_RE = /"[^"]{3,}"/
export const RECALL_INTENT = "auto-recall before answering"

export function formatRecallContext(items: NoteItem[]): string | null {
	if (items.length === 0) return null
	const lines = [
		"<dexi-context>",
		"Notes from the user's Dexi library that may be relevant (use dexi_get for full text):",
	]
	for (const i of items) {
		const title = (i.title || "(untitled)").trim()
		const snippet = (i.snippet || "").trim().replace(/\s*\n\s*/g, " ")
		const tags = (i.tags || []).join(" ")
		const meta = [i.source, tags].filter(Boolean).join(" · ")
		lines.push(`- ${title} [${i.id}]${meta ? ` (${meta})` : ""}${snippet ? `: ${snippet}` : ""}`)
	}
	lines.push("</dexi-context>")
	return lines.join("\n")
}

export async function recallItems(api: DexiApi, cfg: DexiConfig, rawQuery: string): Promise<NoteItem[]> {
	const n = cfg.recallResults
	const q = rawQuery.trim().slice(0, 500)
	if (!q) return []
	const opts = { timeoutMs: cfg.recallTimeoutMs, intent: RECALL_INTENT }
	let items: NoteItem[]
	try {
		items = (await dexi.semanticSearch(api, q, n, opts)).filter(
			(i) => Number(i.similarity ?? 0) >= cfg.recallMinSimilarity,
		)
	} catch (err) {
		log.debug(`recall: semantic search failed (${err instanceof Error ? err.message : String(err)})`)
		return []
	}
	if (HASHTAG_RE.test(q) || QUOTED_RE.test(q)) {
		try {
			const kw = await dexi.searchNotes(api, q, n, opts)
			const seen = new Set(items.map((i) => i.id))
			for (const i of kw.items) if (!seen.has(i.id)) items.push(i)
		} catch {
			// keyword pass is a bonus
		}
	}
	return items.slice(0, n)
}

/** Full recall: returns the `<dexi-context>` block or null. */
export async function buildRecallContext(api: DexiApi, cfg: DexiConfig, rawQuery: string): Promise<string | null> {
	const items = await recallItems(api, cfg, rawQuery)
	return formatRecallContext(items)
}
