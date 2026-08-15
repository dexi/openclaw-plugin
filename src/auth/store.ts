/**
 * On-disk OAuth state: `<stateDir>/dexi/oauth.json`, mode 0600, written
 * atomically. One entry per MCP URL so a dev server and production never
 * share tokens. Both the gateway process and `openclaw dexi …` CLI processes
 * read this file; every read goes to disk (no in-memory caching of tokens) so
 * a refresh performed by one process is visible to the other.
 *
 * OpenClaw's keyed stores are reserved for bundled plugins, and config
 * SecretRefs are for values in openclaw.json — neither fits plugin-minted
 * OAuth tokens, hence a plain file.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type StoredClient = {
	client_id: string
	client_secret?: string
	client_id_issued_at?: number
	client_secret_expires_at?: number
	redirect_uris?: string[]
	[key: string]: unknown
}

export type StoredTokens = {
	access_token: string
	token_type: string
	expires_in?: number
	scope?: string
	refresh_token?: string
	[key: string]: unknown
}

export type ServerAuthState = {
	client?: StoredClient
	tokens?: StoredTokens
	codeVerifier?: string
	/** Redirect URI of an in-progress `openclaw dexi login` (for `--code` completion). */
	pendingRedirectUrl?: string
	discovery?: Record<string, unknown>
	scope?: string
	updatedAt?: string
}

type StoreFile = {
	version: 1
	servers: Record<string, ServerAuthState>
}

/** OpenClaw's state dir: OPENCLAW_STATE_DIR, else ~/.openclaw. Callers inside
 * the plugin should prefer `api.runtime.state.resolveStateDir(process.env)`
 * and pass the result in; this fallback matches its defaults. */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.OPENCLAW_STATE_DIR?.trim()
	if (fromEnv) return path.resolve(fromEnv.replace(/^~(?=$|\/)/, os.homedir()))
	return path.join(os.homedir(), ".openclaw")
}

export function oauthStorePath(stateDir: string): string {
	return path.join(stateDir, "dexi", "oauth.json")
}

export class OAuthStore {
	constructor(readonly filePath: string) {}

	static forStateDir(stateDir: string): OAuthStore {
		return new OAuthStore(oauthStorePath(stateDir))
	}

	private readAll(): StoreFile {
		try {
			const raw = fs.readFileSync(this.filePath, "utf8")
			const parsed = JSON.parse(raw) as Partial<StoreFile>
			if (parsed && typeof parsed === "object" && parsed.servers && typeof parsed.servers === "object") {
				return { version: 1, servers: parsed.servers }
			}
		} catch {
			// missing or corrupt → empty
		}
		return { version: 1, servers: {} }
	}

	private writeAll(data: StoreFile): void {
		const dir = path.dirname(this.filePath)
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
		const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
		fs.renameSync(tmp, this.filePath)
		try {
			fs.chmodSync(this.filePath, 0o600)
		} catch {
			// best effort (Windows)
		}
	}

	get(serverUrl: string): ServerAuthState {
		return this.readAll().servers[serverUrl] ?? {}
	}

	update(serverUrl: string, patch: Partial<ServerAuthState>): ServerAuthState {
		const all = this.readAll()
		const next: ServerAuthState = { ...(all.servers[serverUrl] ?? {}), ...patch, updatedAt: new Date().toISOString() }
		for (const key of Object.keys(next) as Array<keyof ServerAuthState>) {
			if (next[key] === undefined) delete next[key]
		}
		all.servers[serverUrl] = next
		this.writeAll(all)
		return next
	}

	/** Remove one field or the whole entry. */
	clear(serverUrl: string, fields?: Array<keyof ServerAuthState>): void {
		const all = this.readAll()
		if (!all.servers[serverUrl]) return
		if (!fields) {
			delete all.servers[serverUrl]
		} else {
			const entry = { ...all.servers[serverUrl] }
			for (const f of fields) delete entry[f]
			all.servers[serverUrl] = entry
		}
		this.writeAll(all)
	}

	hasTokens(serverUrl: string): boolean {
		return Boolean(this.get(serverUrl).tokens?.access_token)
	}
}
