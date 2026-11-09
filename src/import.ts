/**
 * `openclaw dexi import` — move an agent's native memory files into Dexi as
 * notes, deterministically (no LLM call).
 *
 * Layouts understood: OpenClaw memory-core (`<workspace>/MEMORY.md` plus
 * daily `<workspace>/memory/YYYY-MM-DD.md` logs), Hermes (`memories/MEMORY.md`
 * + `USER.md`), or with `--all` any folder of markdown. A daily log becomes
 * one note; a curated file becomes one note per top-level section so a long
 * MEMORY.md does not turn into a single unsearchable blob. Every note carries
 * the source agent's tag, the shared #memory tag and #imported, plus
 * `imported_from::` (and `logged::` for daily logs) properties.
 *
 * Idempotent: a manifest (`<stateDir>/dexi/imports.json`) maps each
 * file/section to the note it became and a content hash, so re-running after
 * a week of new daily logs adds only the new ones and rewrites sections whose
 * text changed instead of duplicating them.
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { type DexiApi, dexi } from "./client.js"
import { SHARED_MEMORY_TAG } from "./digest.js"

export const IMPORT_TAG = "#imported"
/** Per-note body cap — memory files are small (Hermes caps MEMORY.md at ~2k
 * chars); daily logs can grow, so leave room but never ship a megabyte. */
export const MAX_NOTE_CHARS = 30_000

export type SourceFile = { relPath: string; content: string }
export type PlannedNote = { key: string; title: string; text: string; source: string; hash: string }

const DAILY_RE = /(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/i
const CURATED = new Set(["memory.md", "user.md"])
const MEMORY_DIRS = new Set(["memory", "memories"])
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/

function isMarkdown(name: string): boolean {
	return name.toLowerCase().endsWith(".md")
}

function walk(dir: string, out: string[]): void {
	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return
	}
	for (const e of entries) {
		if (e.name.startsWith(".") || e.name === "node_modules") continue
		const full = path.join(dir, e.name)
		if (e.isDirectory()) walk(full, out)
		else if (e.isFile() && isMarkdown(e.name)) out.push(full)
	}
}

/**
 * Files to import under `root` (a file or a directory). Without `all`, a
 * directory yields only the memory layout: root-level MEMORY.md / USER.md and
 * every markdown file under a `memory/` or `memories/` subfolder (or the
 * whole tree when `root` itself is one of those folders). Agent config files
 * that share the workspace (AGENTS.md, SOUL.md, TOOLS.md…) are never memory.
 */
export function discoverMemoryFiles(root: string, opts: { all?: boolean } = {}): SourceFile[] {
	const abs = path.resolve(root)
	let stat: fs.Stats
	try {
		stat = fs.statSync(abs)
	} catch {
		return []
	}
	const read = (file: string, base: string): SourceFile | null => {
		try {
			return { relPath: path.relative(base, file).split(path.sep).join("/"), content: fs.readFileSync(file, "utf8") }
		} catch {
			return null
		}
	}
	if (stat.isFile()) {
		const f = read(abs, path.dirname(abs))
		return f ? [f] : []
	}
	const files: string[] = []
	if (opts.all || MEMORY_DIRS.has(path.basename(abs).toLowerCase())) {
		walk(abs, files)
	} else {
		for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
			const full = path.join(abs, e.name)
			if (e.isFile() && CURATED.has(e.name.toLowerCase())) files.push(full)
			else if (e.isDirectory() && MEMORY_DIRS.has(e.name.toLowerCase())) walk(full, files)
		}
	}
	files.sort()
	return files.map((f) => read(f, abs)).filter((f): f is SourceFile => f !== null)
}

function slug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section"
}

function fileLabel(relPath: string, fileTitle: string | null): string {
	const base = path.posix.basename(relPath)
	const lower = base.toLowerCase()
	if (lower === "memory.md") return "Memory"
	if (lower === "user.md") return "User profile"
	return fileTitle ?? base.replace(/\.md$/i, "")
}

type Section = { heading: string | null; body: string }

/** Split a curated file at its highest heading level. A lone `# Title` line
 * at the top is the file's title, not a section (a lone `## Heading` is a
 * section); text before the first section heading stays as a preamble. */
export function splitSections(content: string): { fileTitle: string | null; sections: Section[] } {
	const lines = content.replace(/\r\n?/g, "\n").split("\n")
	const headings = lines
		.map((line, i) => {
			const m = HEADING_RE.exec(line)
			return m ? { i, level: m[1]!.length, text: m[2]! } : null
		})
		.filter((h): h is { i: number; level: number; text: string } => h !== null)
	let fileTitle: string | null = null
	let start = 0
	const firstContent = lines.findIndex((l) => l.trim() !== "")
	const first = headings[0]
	if (first && first.level === 1 && first.i === firstContent && !headings.some((h, idx) => idx > 0 && h.level === 1)) {
		fileTitle = first.text
		start = first.i + 1
		headings.shift()
	}
	if (headings.length === 0) {
		const body = lines.slice(start).join("\n").trim()
		return { fileTitle, sections: body ? [{ heading: null, body }] : [] }
	}
	const level = Math.min(...headings.map((h) => h.level))
	const cuts = headings.filter((h) => h.level === level)
	const sections: Section[] = []
	const preamble = lines.slice(start, cuts[0]!.i).join("\n").trim()
	if (preamble) sections.push({ heading: null, body: preamble })
	cuts.forEach((h, idx) => {
		const end = idx + 1 < cuts.length ? cuts[idx + 1]!.i : lines.length
		const body = lines.slice(h.i + 1, end).join("\n").trim()
		if (body) sections.push({ heading: h.text, body })
	})
	return { fileTitle, sections }
}

function tagLine(agentTag: string): string {
	const tags = [agentTag, SHARED_MEMORY_TAG, IMPORT_TAG]
	return [...new Set(tags)].join(" ")
}

function finish(text: string): string {
	return text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…` : text
}

function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/** Pure: source files → the notes they become. `agentTag` names the agent
 * whose memory this was (#openclaw, #hermes…), not the one importing it. */
export function planImport(files: SourceFile[], opts: { agentTag: string }): PlannedNote[] {
	const out: PlannedNote[] = []
	const seen = new Set<string>()
	const unique = (key: string): string => {
		let k = key
		for (let n = 2; seen.has(k); n++) k = `${key}-${n}`
		seen.add(k)
		return k
	}
	for (const f of files) {
		const content = f.content.replace(/\r\n?/g, "\n").trim()
		if (!content) continue
		const daily = DAILY_RE.exec(f.relPath)
		if (daily) {
			const date = daily[1]!
			const { fileTitle, sections } = splitSections(content)
			const body = sections.map((s) => (s.heading ? `## ${s.heading}\n${s.body}` : s.body)).join("\n\n") || content
			const text = finish(
				[`${tagLine(opts.agentTag)} Memory imported from ${f.relPath}.`, "", body, "", `logged:: ${date}`, `imported_from:: ${f.relPath}`].join("\n"),
			)
			out.push({ key: unique(f.relPath), title: fileTitle && fileTitle !== date ? `Memory log ${date} — ${fileTitle}` : `Memory log ${date}`, text, source: f.relPath, hash: hash(text) })
			continue
		}
		const { fileTitle, sections } = splitSections(content)
		const label = fileLabel(f.relPath, fileTitle)
		for (const s of sections) {
			const title = s.heading ? `${label}: ${s.heading}` : label
			const text = finish([`${tagLine(opts.agentTag)} Memory imported from ${f.relPath}.`, "", s.body, "", `imported_from:: ${f.relPath}`].join("\n"))
			out.push({ key: unique(s.heading ? `${f.relPath}#${slug(s.heading)}` : f.relPath), title: title.slice(0, 200), text, source: f.relPath, hash: hash(text) })
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Manifest

export type ImportRecord = { noteId: string; hash: string; title: string; importedAt: string }

export interface ImportStateStore {
	get(key: string): ImportRecord | undefined
	set(key: string, record: ImportRecord): void
}

export class FileImportStateStore implements ImportStateStore {
	constructor(readonly filePath: string) {}

	static forStateDir(stateDir: string): FileImportStateStore {
		return new FileImportStateStore(path.join(stateDir, "dexi", "imports.json"))
	}

	private readAll(): Record<string, ImportRecord> {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { entries?: Record<string, ImportRecord> }
			return parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : {}
		} catch {
			return {}
		}
	}

	get(key: string): ImportRecord | undefined {
		return this.readAll()[key]
	}

	set(key: string, record: ImportRecord): void {
		const all = this.readAll()
		all[key] = record
		fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
		const tmp = `${this.filePath}.${process.pid}.tmp`
		fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: all }, null, 2), { mode: 0o600 })
		fs.renameSync(tmp, this.filePath)
	}
}

export class MemoryImportStateStore implements ImportStateStore {
	readonly map = new Map<string, ImportRecord>()
	get(k: string) {
		return this.map.get(k)
	}
	set(k: string, r: ImportRecord) {
		this.map.set(k, r)
	}
}

// ---------------------------------------------------------------------------
// Runner

export type ImportSummary = { created: number; updated: number; unchanged: number; failed: number }

export async function runImport(
	api: DexiApi,
	plan: PlannedNote[],
	state: ImportStateStore,
	opts: { dryRun?: boolean; print: (line: string) => void; now?: () => Date },
): Promise<ImportSummary> {
	const sum: ImportSummary = { created: 0, updated: 0, unchanged: 0, failed: 0 }
	const now = opts.now ?? (() => new Date())
	for (const n of plan) {
		const prev = state.get(n.key)
		if (prev && prev.hash === n.hash) {
			sum.unchanged++
			continue
		}
		const verb = prev ? "update" : "create"
		if (opts.dryRun) {
			opts.print(`  would ${verb}: ${n.title}  (${n.source}, ${n.text.length} chars)`)
			if (prev) sum.updated++
			else sum.created++
			continue
		}
		try {
			if (prev) {
				await api.callTool("update_note", { note_id: prev.noteId, title: n.title, text: n.text, mode: "replace" }, { intent: "memory import (changed section)" })
				state.set(n.key, { noteId: prev.noteId, hash: n.hash, title: n.title, importedAt: now().toISOString() })
				sum.updated++
				opts.print(`  updated: ${n.title}`)
			} else {
				const note = await dexi.createNote(api, n.title, n.text, { intent: "memory import" })
				state.set(n.key, { noteId: note.id, hash: n.hash, title: n.title, importedAt: now().toISOString() })
				sum.created++
				opts.print(`  created: ${n.title} — ${note.url ?? note.id}`)
			}
		} catch (err) {
			sum.failed++
			opts.print(`  FAILED: ${n.title} — ${err instanceof Error ? err.message : String(err)}`)
		}
	}
	return sum
}
