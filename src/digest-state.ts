/**
 * Persisted session → digest-note mapping (`<stateDir>/dexi/digests.json`).
 * Without it, every gateway restart or one-shot `openclaw agent` run would
 * start a fresh digest note for a conversation that already has one. Entries
 * are dropped when the session actually ends (session_end: new/reset/idle/
 * daily/deleted) and pruned after 30 days.
 */
import fs from "node:fs"
import path from "node:path"

export type DigestRecord = { noteId: string; createdAt: string; updatedAt: string; flushedTurns?: number }

export interface DigestStateStore {
	get(sessionKey: string): DigestRecord | undefined
	set(sessionKey: string, record: DigestRecord): void
	delete(sessionKey: string): void
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export class FileDigestStateStore implements DigestStateStore {
	constructor(readonly filePath: string) {}

	static forStateDir(stateDir: string): FileDigestStateStore {
		return new FileDigestStateStore(path.join(stateDir, "dexi", "digests.json"))
	}

	private readAll(): Record<string, DigestRecord> {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { sessions?: Record<string, DigestRecord> }
			return parsed?.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {}
		} catch {
			return {}
		}
	}

	private writeAll(sessions: Record<string, DigestRecord>): void {
		const cutoff = Date.now() - MAX_AGE_MS
		for (const [k, v] of Object.entries(sessions)) {
			const t = Date.parse(v.updatedAt || v.createdAt)
			if (Number.isFinite(t) && t < cutoff) delete sessions[k]
		}
		fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
		const tmp = `${this.filePath}.${process.pid}.tmp`
		fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions }, null, 2), { mode: 0o600 })
		fs.renameSync(tmp, this.filePath)
	}

	get(sessionKey: string): DigestRecord | undefined {
		return this.readAll()[sessionKey]
	}

	set(sessionKey: string, record: DigestRecord): void {
		const all = this.readAll()
		all[sessionKey] = record
		this.writeAll(all)
	}

	delete(sessionKey: string): void {
		const all = this.readAll()
		if (!(sessionKey in all)) return
		delete all[sessionKey]
		this.writeAll(all)
	}
}

export class MemoryDigestStateStore implements DigestStateStore {
	readonly map = new Map<string, DigestRecord>()
	get(k: string) {
		return this.map.get(k)
	}
	set(k: string, r: DigestRecord) {
		this.map.set(k, r)
	}
	delete(k: string) {
		this.map.delete(k)
	}
}
