import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { defaultWorkspace } from "../src/cli.js"
import { FileImportStateStore, MemoryImportStateStore, discoverMemoryFiles, planImport, runImport, splitSections } from "../src/import.js"
import { FakeDexiClient, defaultHandler } from "./helpers.js"

const MEMORY_MD = `# Long-term memory

Preamble the agent wrote before any section.

## Preferences
- Likes terse answers
- Timezone: Pacific

## Projects
### Atlas
API rewrite, due Q1.

## Empty section
`

const tmpDirs: string[] = []
function workspace(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dexi-import-"))
	tmpDirs.push(dir)
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(dir, rel)
		fs.mkdirSync(path.dirname(full), { recursive: true })
		fs.writeFileSync(full, content)
	}
	return dir
}
afterEach(() => {
	for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe("splitSections", () => {
	it("treats a lone top heading as the file title and splits at the next level", () => {
		const { fileTitle, sections } = splitSections(MEMORY_MD)
		expect(fileTitle).toBe("Long-term memory")
		expect(sections.map((s) => s.heading)).toEqual([null, "Preferences", "Projects"])
		expect(sections[0]!.body).toBe("Preamble the agent wrote before any section.")
		expect(sections[2]!.body).toBe("### Atlas\nAPI rewrite, due Q1.")
	})
	it("keeps a heading-less file as one section and drops empty files", () => {
		expect(splitSections("just facts\nmore facts").sections).toEqual([{ heading: null, body: "just facts\nmore facts" }])
		expect(splitSections("\n\n").sections).toEqual([])
	})
	it("does not mistake the first of several level-1 headings, or a lone level-2 heading, for a title", () => {
		const { fileTitle, sections } = splitSections("# A\none\n# B\ntwo")
		expect(fileTitle).toBeNull()
		expect(sections.map((s) => s.heading)).toEqual(["A", "B"])
		const single = splitSections("## Name\nMaya")
		expect(single.fileTitle).toBeNull()
		expect(single.sections).toEqual([{ heading: "Name", body: "Maya" }])
	})
})

describe("discoverMemoryFiles", () => {
	it("picks the memory layout out of a workspace and ignores agent config files", () => {
		const dir = workspace({
			"MEMORY.md": MEMORY_MD,
			"USER.md": "## Name\nMaya",
			"AGENTS.md": "not memory",
			"SOUL.md": "not memory",
			"memory/2026-10-14.md": "# 2026-10-14\n- asked about Railway ports",
			"memory/2026-10-15.md": "- asked about pgvector",
			"memory/notes.txt": "ignored",
			"memory/.hidden.md": "ignored",
		})
		expect(discoverMemoryFiles(dir).map((f) => f.relPath)).toEqual(["MEMORY.md", "USER.md", "memory/2026-10-14.md", "memory/2026-10-15.md"])
		expect(discoverMemoryFiles(dir, { all: true }).map((f) => f.relPath)).toEqual([
			"AGENTS.md",
			"MEMORY.md",
			"SOUL.md",
			"USER.md",
			"memory/2026-10-14.md",
			"memory/2026-10-15.md",
		])
	})
	it("takes a memories/ folder whole, a single file as itself, and nothing for a missing path", () => {
		const dir = workspace({ "memories/MEMORY.md": "facts", "memories/USER.md": "profile", "memories/extra.md": "x" })
		expect(discoverMemoryFiles(path.join(dir, "memories")).map((f) => f.relPath)).toEqual(["MEMORY.md", "USER.md", "extra.md"])
		expect(discoverMemoryFiles(path.join(dir, "memories", "USER.md"))).toEqual([{ relPath: "USER.md", content: "profile" }])
		expect(discoverMemoryFiles(path.join(dir, "nope"))).toEqual([])
	})
})

describe("planImport", () => {
	it("makes one note per section of a curated file with the shared tags and provenance property", () => {
		const plan = planImport([{ relPath: "MEMORY.md", content: MEMORY_MD }], { agentTag: "#openclaw" })
		expect(plan.map((n) => n.title)).toEqual(["Memory", "Memory: Preferences", "Memory: Projects"])
		expect(plan.map((n) => n.key)).toEqual(["MEMORY.md", "MEMORY.md#preferences", "MEMORY.md#projects"])
		expect(plan[1]!.text).toBe(
			"#openclaw #memory #imported Memory imported from MEMORY.md.\n\n- Likes terse answers\n- Timezone: Pacific\n\nimported_from:: MEMORY.md",
		)
		expect(plan[1]!.hash).toHaveLength(16)
	})
	it("makes one note per daily log with a logged:: date, labels USER.md, and dedupes #memory as the agent tag", () => {
		const plan = planImport(
			[
				{ relPath: "memory/2026-10-14.md", content: "# 2026-10-14\n## Morning\n- asked about Railway ports" },
				{ relPath: "memory/2026-10-15.md", content: "- asked about pgvector" },
				{ relPath: "USER.md", content: "## Name\nMaya" },
				{ relPath: "memory/empty.md", content: "\n" },
			],
			{ agentTag: "#memory" },
		)
		expect(plan.map((n) => n.title)).toEqual(["Memory log 2026-10-14", "Memory log 2026-10-15", "User profile: Name"])
		expect(plan[0]!.text).toBe(
			"#memory #imported Memory imported from memory/2026-10-14.md.\n\n## Morning\n- asked about Railway ports\n\nlogged:: 2026-10-14\nimported_from:: memory/2026-10-14.md",
		)
		expect(plan[1]!.text).toContain("logged:: 2026-10-15")
	})
	it("keeps duplicate headings apart and caps huge sections", () => {
		const plan = planImport([{ relPath: "m.md", content: `## Same\na\n## Same\n${"b".repeat(40_000)}` }], { agentTag: "#hermes" })
		expect(plan.map((n) => n.key)).toEqual(["m.md#same", "m.md#same-2"])
		expect(plan[1]!.text.length).toBeLessThanOrEqual(30_000)
		expect(plan[1]!.text.endsWith("…")).toBe(true)
	})
})

describe("runImport", () => {
	const plan = () => planImport([{ relPath: "MEMORY.md", content: "## A\none\n## B\ntwo" }], { agentTag: "#openclaw" })

	it("creates new notes, skips unchanged ones on re-run, and rewrites changed sections in place", async () => {
		let n = 0
		const api = new FakeDexiClient((name, args) => (name === "create_note" ? { id: `note-${++n}`, title: args.title } : defaultHandler(name, args)))
		const state = new MemoryImportStateStore()
		const lines: string[] = []
		const print = (l: string) => lines.push(l)
		expect(await runImport(api, plan(), state, { print })).toEqual({ created: 2, updated: 0, unchanged: 0, failed: 0 })
		expect(api.callsTo("create_note").map((c) => c.args.title)).toEqual(["Memory: A", "Memory: B"])
		expect(api.callsTo("create_note")[0]!.args.intent).toBe("memory import")
		expect(state.get("MEMORY.md#a")?.noteId).toBe("note-1")

		expect(await runImport(api, plan(), state, { print })).toEqual({ created: 0, updated: 0, unchanged: 2, failed: 0 })
		expect(api.callsTo("create_note")).toHaveLength(2)

		const changed = planImport([{ relPath: "MEMORY.md", content: "## A\none, revised\n## B\ntwo" }], { agentTag: "#openclaw" })
		expect(await runImport(api, changed, state, { print })).toEqual({ created: 0, updated: 1, unchanged: 1, failed: 0 })
		const upd = api.callsTo("update_note")
		expect(upd).toHaveLength(1)
		expect(upd[0]!.args).toMatchObject({ note_id: "note-1", title: "Memory: A", mode: "replace" })
		expect(String(upd[0]!.args.text)).toContain("one, revised")
		expect(state.get("MEMORY.md#a")?.hash).toBe(changed[0]!.hash)
	})

	it("dry run writes nothing and counts what it would do; failures are counted and don't stop the run", async () => {
		const api = new FakeDexiClient()
		const state = new MemoryImportStateStore()
		const lines: string[] = []
		expect(await runImport(api, plan(), state, { dryRun: true, print: (l) => lines.push(l) })).toEqual({ created: 2, updated: 0, unchanged: 0, failed: 0 })
		expect(api.calls).toEqual([])
		expect(lines[0]).toContain("would create: Memory: A")

		const flaky = new FakeDexiClient((name, args) => (name === "create_note" && args.title === "Memory: A" ? new Error("note cap reached") : defaultHandler(name, args)))
		const sum = await runImport(flaky, plan(), state, { print: (l) => lines.push(l) })
		expect(sum).toEqual({ created: 1, updated: 0, unchanged: 0, failed: 1 })
		expect(lines.some((l) => l.includes("FAILED: Memory: A — note cap reached"))).toBe(true)
		expect(state.get("MEMORY.md#a")).toBeUndefined()
		expect(state.get("MEMORY.md#b")?.noteId).toBe("new-1")
	})
})

describe("FileImportStateStore / defaultWorkspace", () => {
	it("persists records under <stateDir>/dexi/imports.json with a private mode", () => {
		const dir = workspace({})
		const store = FileImportStateStore.forStateDir(dir)
		expect(store.get("x")).toBeUndefined()
		store.set("x", { noteId: "n1", hash: "h", title: "T", importedAt: "2026-11-08T00:00:00Z" })
		expect(FileImportStateStore.forStateDir(dir).get("x")?.noteId).toBe("n1")
		expect(fs.statSync(path.join(dir, "dexi", "imports.json")).mode & 0o777).toBe(0o600)
	})
	it("reads agents.defaults.workspace from the host config, else ~/.openclaw/workspace", () => {
		expect(defaultWorkspace({ agents: { defaults: { workspace: "/srv/ws" } } })).toBe("/srv/ws")
		expect(defaultWorkspace({ agents: { defaults: { workspace: "~/ws" } } })).toBe(path.join(os.homedir(), "ws"))
		expect(defaultWorkspace(undefined)).toBe(path.join(os.homedir(), ".openclaw", "workspace"))
	})
})
