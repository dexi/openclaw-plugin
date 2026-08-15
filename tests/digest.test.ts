import { describe, expect, it } from "vitest"
import { MAX_TOTAL, buildDigest, buildDigestAppend } from "../src/digest.js"

const NOW = new Date(2026, 7, 15, 9, 30) // local time

describe("buildDigest", () => {
	it("produces the Hermes-style digest", () => {
		const d = buildDigest(
			[
				{ user: "<dexi-context>injected</dexi-context> How do I set up pgvector on Railway?", assistant: "Use the postgres-ssl image." },
				{ user: "And locally?", assistant: "Use the pgvector/pgvector:pg17 image.\nDone." },
			],
			{ tag: "#openclaw", sessionKey: "agent:main:abc", now: NOW, channel: "telegram" },
		)!
		expect(d.title).toBe("OpenClaw session 2026-08-15 — How do I set up pgvector on Railway?")
		expect(d.text).toBe(
			[
				"#openclaw Session digest written by OpenClaw (telegram) on 2026-08-15 09:30.",
				"",
				"Asked:",
				"- How do I set up pgvector on Railway?",
				"- And locally?",
				"",
				"Last answer:",
				"Use the pgvector/pgvector:pg17 image. Done.",
				"",
				"Session: agent:main:abc",
			].join("\n"),
		)
		expect(d.text).not.toContain("injected")
	})

	it("returns null without a user turn, lists at most 12 asks, and caps the total", () => {
		expect(buildDigest([], { tag: "#t" })).toBeNull()
		expect(buildDigest([{ user: "", assistant: "only assistant" }], { tag: "#t" })).toBeNull()
		const many = Array.from({ length: 15 }, (_, i) => ({ user: `q${i} ${"x".repeat(300)}`, assistant: "a".repeat(5000) }))
		const d = buildDigest(many, { tag: "#t", now: NOW })!
		expect(d.text).toContain("- … and 3 more turns")
		expect(d.text.split("\n").filter((l) => l.startsWith("- ")).length).toBe(13)
		expect(d.text.length).toBeLessThanOrEqual(MAX_TOTAL)
		expect(d.text).toContain("…")
	})
})

describe("buildDigestAppend", () => {
	it("renders a continuation block", () => {
		const t = buildDigestAppend([{ user: "Next question?", assistant: "Next answer." }], { now: NOW })
		expect(t).toBe("Continued 2026-08-15 09:30:\n- Next question?\n\nLast answer:\nNext answer.")
		expect(buildDigestAppend([{ user: "", assistant: "" }], { now: NOW })).toBeNull()
	})
})
