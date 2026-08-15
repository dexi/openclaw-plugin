/**
 * The memory section OpenClaw places in the system prompt while Dexi owns
 * the memory slot (registerMemoryCapability.promptBuilder). Static text —
 * per-turn context goes through the before_prompt_build hook instead.
 * Port of hermes provider.system_prompt_block.
 */
import type { DexiConfig } from "./config.js"

export function buildPromptSection(cfg: DexiConfig, params: { availableTools: Set<string> }): string[] {
	const hasSearch = params.availableTools.has("dexi_search")
	const hasSave = params.availableTools.has("dexi_save")
	if (!hasSearch && !hasSave) return []
	const lines = [
		"## Memory (Dexi)",
		"",
		"Memory is the user's Dexi notes library (typed notes, clipped web pages, emailed articles, RSS entries), hosted at app.dexi.net. Do not read or write local memory files like MEMORY.md or memory/*.md — they are not in use.",
	]
	if (hasSearch) {
		lines.push(
			"Before answering questions about the user's own material, research, or past decisions, search it with dexi_search (hybrid keyword+semantic; full_text=true to read bodies, dexi_get for one note). Relevant notes may already be pre-loaded in a <dexi-context> block — treat that as a starting point, not the answer. Cite notes by title with their url.",
		)
	}
	if (cfg.readOnly || !hasSave) {
		lines.push("This connection is read-only.")
	} else {
		lines.push(
			"Save with dexi_save only when the user asks or when a distilled fact/decision is clearly worth keeping — short noun-phrase title, plain text, 1-3 existing #hashtags (dexi_tags). Prefer dexi_append over near-duplicate notes. The user can also type /remember <text>.",
		)
	}
	if (cfg.sessionDigest && !cfg.readOnly) {
		lines.push(`A ${cfg.digestTag} digest note of this session is written to Dexi automatically when it ends.`)
	}
	return lines
}
