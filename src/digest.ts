/**
 * Deterministic session digest — no LLM call inside the plugin.
 *
 * Turns the buffered (user, assistant) exchanges of one OpenClaw session into
 * one Dexi note: what was asked, the last answer, and the session key. A
 * searchable breadcrumb ("what did I ask OpenClaw about X?"), not a memory
 * extraction. Port of hermes-plugin/hermes_dexi/digest.py.
 */
import { clean, firstLine } from "./text.js"

export const MAX_TURNS_LISTED = 12
export const MAX_LINE = 240
export const MAX_TOTAL = 6000

export type Turn = { user: string; assistant: string }

function stamp(d: Date): { date: string; dateTime: string } {
	const p = (n: number) => String(n).padStart(2, "0")
	const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
	return { date, dateTime: `${date} ${p(d.getHours())}:${p(d.getMinutes())}` }
}

/** Body lines for a set of turns (no header) — used for both the first
 * write and later appends. */
export function digestTurnLines(turns: Turn[]): string[] {
	const lines: string[] = []
	for (const t of turns.slice(0, MAX_TURNS_LISTED)) {
		if (t.user) lines.push(`- ${firstLine(t.user, MAX_LINE)}`)
	}
	if (turns.length > MAX_TURNS_LISTED) {
		lines.push(`- … and ${turns.length - MAX_TURNS_LISTED} more turns`)
	}
	return lines
}

/**
 * Return {title, text} for the digest note, or null when there is nothing
 * worth saving (no non-trivial user turn).
 */
export function buildDigest(
	rawTurns: Turn[],
	opts: { tag: string; sessionKey?: string; now?: Date; channel?: string },
): { title: string; text: string } | null {
	const turns = rawTurns
		.map((t) => ({ user: clean(t.user), assistant: clean(t.assistant) }))
		.filter((t) => t.user || t.assistant)
	if (turns.length === 0) return null
	const firstUser = turns.find((t) => t.user)?.user ?? ""
	if (!firstUser) return null
	const when = stamp(opts.now ?? new Date())
	const title = `OpenClaw session ${when.date} — ${firstLine(firstUser, 60)}`
	const lines = [
		`${opts.tag} Session digest written by OpenClaw${opts.channel ? ` (${opts.channel})` : ""} on ${when.dateTime}.`,
		"",
		"Asked:",
		...digestTurnLines(turns),
	]
	const lastAnswer = [...turns].reverse().find((t) => t.assistant)?.assistant ?? ""
	if (lastAnswer) lines.push("", "Last answer:", firstLine(lastAnswer, 1200))
	if (opts.sessionKey) lines.push("", `Session: ${opts.sessionKey}`)
	let text = lines.join("\n")
	if (text.length > MAX_TOTAL) text = `${text.slice(0, MAX_TOTAL - 1).trimEnd()}…`
	return { title, text }
}

/** Text appended to an existing digest note for turns that arrived after the
 * first flush. */
export function buildDigestAppend(
	rawTurns: Turn[],
	opts: { now?: Date },
): string | null {
	const turns = rawTurns
		.map((t) => ({ user: clean(t.user), assistant: clean(t.assistant) }))
		.filter((t) => t.user || t.assistant)
	if (turns.length === 0) return null
	const when = stamp(opts.now ?? new Date())
	const lines = [`Continued ${when.dateTime}:`, ...digestTurnLines(turns)]
	const lastAnswer = [...turns].reverse().find((t) => t.assistant)?.assistant ?? ""
	if (lastAnswer) lines.push("", "Last answer:", firstLine(lastAnswer, 1200))
	let text = lines.join("\n")
	if (text.length > MAX_TOTAL) text = `${text.slice(0, MAX_TOTAL - 1).trimEnd()}…`
	return text
}
