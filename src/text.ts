/**
 * Text helpers shared by recall, capture, and commands.
 *
 * - `stripInboundMetadata`: OpenClaw prefixes channel prompts with a
 *   timestamp and "untrusted metadata" JSON blocks (sender, conversation,
 *   quoted message). Neither belongs in a search query or a digest.
 * - `stripContextBlocks`: removes our own `<dexi-context>` injection (and any
 *   other plugin's `<*-context>` block) so captured text never re-embeds it.
 * - `isTrivialPrompt`: the Hermes gate — greetings/acks/slash commands don't
 *   deserve a recall round-trip.
 */

const INBOUND_META_SENTINELS = new Set([
	"Conversation info (untrusted metadata):",
	"Sender (untrusted metadata):",
	"Thread starter (untrusted, for context):",
	"Replied message (untrusted, for context):",
	"Forwarded message context (untrusted metadata):",
	"Chat history since last reply (untrusted, for context):",
])

const LEADING_TIMESTAMP_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */

export function stripInboundMetadata(text: string): string {
	if (!text) return text
	const lines = text.replace(LEADING_TIMESTAMP_RE, "").split("\n")
	const out: string[] = []
	let inMeta = false
	let inFence = false
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? ""
		if (!inMeta && INBOUND_META_SENTINELS.has(line.trim())) {
			if (lines[i + 1]?.trim() !== "```json") {
				out.push(line)
				continue
			}
			inMeta = true
			inFence = false
			continue
		}
		if (inMeta) {
			if (!inFence && line.trim() === "```json") {
				inFence = true
				continue
			}
			if (inFence) {
				if (line.trim() === "```") {
					inMeta = false
					inFence = false
				}
				continue
			}
			if (line.trim() === "") continue
			inMeta = false
		}
		out.push(line)
	}
	return out.join("\n").replace(/^\n+/, "").replace(/\n+$/, "")
}

const CONTEXT_BLOCK_RE = /<([a-z][\w-]*-context)>[\s\S]*?<\/\1>\s*/g

export function stripContextBlocks(text: string): string {
	return (text || "").replace(CONTEXT_BLOCK_RE, "")
}

/** Strip injected context + inbound metadata and collapse whitespace. */
export function clean(text: string): string {
	return stripInboundMetadata(stripContextBlocks(text || ""))
		.replace(/\s+/g, " ")
		.trim()
}

const TRIVIAL_WORDS = new Set([
	"hi", "hello", "hey", "yo", "thanks", "thank", "ok", "okay", "yes", "no",
	"sure", "cool", "great", "nice", "bye", "good", "morning", "evening",
])

export function isTrivialPrompt(text: string | undefined | null): boolean {
	if (!text) return true
	const stripped = text.trim()
	if (!stripped || stripped.startsWith("/")) return true
	const words = stripped.replace(/[!.?]+$/, "").toLowerCase().split(/\s+/)
	return words.length <= 2 && TRIVIAL_WORDS.has(words[0] ?? "")
}

/** First line of a text, cut to `limit` chars with an ellipsis. */
export function firstLine(text: string, limit: number): string {
	const t = clean(text)
	return t.length <= limit ? t : `${t.slice(0, limit - 1).trimEnd()}…`
}

/** Extract the plain-text parts of an OpenClaw session message. */
export function messageText(msg: unknown): { role: string; text: string } | null {
	if (!msg || typeof msg !== "object") return null
	const m = msg as Record<string, unknown>
	const role = typeof m.role === "string" ? m.role : ""
	if (role !== "user" && role !== "assistant") return null
	const content = m.content
	const parts: string[] = []
	if (typeof content === "string") parts.push(content)
	else if (Array.isArray(content)) {
		for (const block of content) {
			if (!block || typeof block !== "object") continue
			const b = block as Record<string, unknown>
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text)
		}
	}
	const text = parts.join("\n").trim()
	return text ? { role, text } : null
}
