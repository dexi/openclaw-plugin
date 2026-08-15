import { describe, expect, it } from "vitest"
import { clean, firstLine, isTrivialPrompt, messageText, stripContextBlocks, stripInboundMetadata } from "../src/text.js"

const ENVELOPE = `[Fri 2026-08-15 09:00 PDT] Conversation info (untrusted metadata):
\`\`\`json
{"chat_id": "123", "channel": "telegram"}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{"id": "u1", "name": "Julian"}
\`\`\`

What did I save about pgvector?`

describe("stripInboundMetadata", () => {
	it("removes the timestamp and metadata JSON blocks", () => {
		expect(stripInboundMetadata(ENVELOPE)).toBe("What did I save about pgvector?")
	})
	it("leaves a sentinel line alone when no json fence follows", () => {
		expect(stripInboundMetadata("Sender (untrusted metadata):\nhello")).toBe("Sender (untrusted metadata):\nhello")
	})
	it("passes plain text through", () => {
		expect(stripInboundMetadata("plain")).toBe("plain")
		expect(stripInboundMetadata("")).toBe("")
	})
})

describe("stripContextBlocks / clean", () => {
	it("removes our own and other plugins' context blocks", () => {
		const s = "<dexi-context>\n- x\n</dexi-context>\n<supermemory-context>y</supermemory-context> hello"
		expect(stripContextBlocks(s)).toBe("hello")
		expect(clean(`${ENVELOPE}\n<dexi-context>z</dexi-context>`)).toBe("What did I save about pgvector?")
	})
	it("collapses whitespace", () => {
		expect(clean("a\n\n  b\tc")).toBe("a b c")
	})
})

describe("isTrivialPrompt", () => {
	it("gates greetings, acks and slash commands", () => {
		for (const t of ["hi", "Hello!", "ok thanks", "/status", "", "   ", null, undefined]) expect(isTrivialPrompt(t)).toBe(true)
		for (const t of ["what did I save about pgvector", "hi, tell me about my notes", "thanks for the summary yesterday"]) {
			expect(isTrivialPrompt(t)).toBe(false)
		}
	})
})

describe("firstLine / messageText", () => {
	it("cuts with an ellipsis", () => {
		expect(firstLine("a".repeat(100), 10)).toBe(`${"a".repeat(9)}…`)
		expect(firstLine("short", 10)).toBe("short")
	})
	it("extracts text blocks from user/assistant messages only", () => {
		expect(messageText({ role: "user", content: "hi" })).toEqual({ role: "user", text: "hi" })
		expect(messageText({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }] })).toEqual({ role: "assistant", text: "a\nb" })
		expect(messageText({ role: "tool", content: "x" })).toBeNull()
		expect(messageText({ role: "user", content: [] })).toBeNull()
		expect(messageText(null)).toBeNull()
	})
})
