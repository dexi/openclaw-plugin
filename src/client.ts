/**
 * DexiClient — a lazily connected streamable-HTTP MCP client for Dexi's MCP
 * server, with the OAuth provider from ./auth. Every plugin feature (recall,
 * tools, commands, CLI, digest) funnels through `callTool`.
 *
 * Failure policy: auth problems surface as `DexiAuthError` (message tells the
 * user to run `openclaw dexi login`); tool-level errors as `DexiToolError`
 * carrying the server's text; the transport is rebuilt after any transport
 * failure so one dead connection doesn't poison the gateway.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { DexiAuthError, FileOAuthClientProvider, scopeFor } from "./auth/provider.js"
import type { OAuthStore } from "./auth/store.js"
import { noteUrl } from "./config.js"
import { log } from "./logger.js"

export class DexiToolError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "DexiToolError"
	}
}

export type ToolCallOptions = { timeoutMs?: number; signal?: AbortSignal; intent?: string }

export type NoteItem = {
	id: string
	title?: string
	snippet?: string
	text?: string
	text_truncated?: boolean
	tags?: string[]
	source?: string
	source_url?: string
	created?: string
	updated?: string
	similarity?: number
	folder?: string
	shared?: boolean
	owner?: string
	url?: string
	[key: string]: unknown
}

/** Minimal surface the rest of the plugin depends on — FakeDexiClient in
 * tests implements the same interface. */
export interface DexiApi {
	readonly mcpUrl: string
	isConnected(): boolean
	callTool(name: string, args: Record<string, unknown>, opts?: ToolCallOptions): Promise<Record<string, unknown>>
	close(): Promise<void>
}

export type DexiClientOptions = {
	mcpUrl: string
	store: OAuthStore
	readOnly?: boolean
	toolTimeoutMs?: number
	/** Override the auth provider (login flow passes a `login`-mode one). */
	provider?: FileOAuthClientProvider
	clientVersion?: string
}

export class DexiClient implements DexiApi {
	readonly mcpUrl: string
	private readonly store: OAuthStore
	private readonly provider: FileOAuthClientProvider
	private readonly toolTimeoutMs: number
	private readonly clientVersion: string
	private client?: Client
	private transport?: StreamableHTTPClientTransport
	private connecting?: Promise<Client>

	constructor(opts: DexiClientOptions) {
		this.mcpUrl = opts.mcpUrl
		this.store = opts.store
		this.toolTimeoutMs = opts.toolTimeoutMs ?? 30_000
		this.clientVersion = opts.clientVersion ?? "0.0.0"
		this.provider =
			opts.provider ??
			new FileOAuthClientProvider(opts.store, opts.mcpUrl, { kind: "gateway" }, scopeFor(Boolean(opts.readOnly)))
	}

	/** Tokens on disk — no network. */
	isConnected(): boolean {
		return this.store.hasTokens(this.mcpUrl)
	}

	private async connect(): Promise<Client> {
		if (this.client) return this.client
		if (this.connecting) return this.connecting
		this.connecting = (async () => {
			const client = new Client({ name: "openclaw-dexi", version: this.clientVersion })
			const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
				authProvider: this.provider,
			})
			transport.onclose = () => {
				if (this.transport === transport) {
					this.client = undefined
					this.transport = undefined
				}
			}
			try {
				await client.connect(transport)
			} catch (err) {
				await transport.close().catch(() => {})
				throw this.translate(err)
			}
			this.client = client
			this.transport = transport
			return client
		})()
		try {
			return await this.connecting
		} finally {
			this.connecting = undefined
		}
	}

	private translate(err: unknown): Error {
		if (err instanceof DexiAuthError) return err
		if (err instanceof UnauthorizedError) return new DexiAuthError()
		const message = err instanceof Error ? err.message : String(err)
		if (/\b401\b|unauthorized|invalid_token|invalid_grant/i.test(message)) {
			return new DexiAuthError(`Dexi rejected the connection (${message}) — run \`openclaw dexi login\`.`)
		}
		return err instanceof Error ? err : new Error(message)
	}

	private async reset(): Promise<void> {
		const t = this.transport
		this.client = undefined
		this.transport = undefined
		if (t) await t.close().catch(() => {})
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		opts: ToolCallOptions = {},
	): Promise<Record<string, unknown>> {
		if (!this.isConnected()) throw new DexiAuthError()
		const cleanArgs: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) cleanArgs[k] = v
		if (opts.intent && cleanArgs.intent === undefined) cleanArgs.intent = opts.intent
		const timeout = opts.timeoutMs ?? this.toolTimeoutMs

		const attempt = async (): Promise<Record<string, unknown>> => {
			const client = await this.connect()
			const res = (await client.callTool({ name, arguments: cleanArgs }, undefined, {
				timeout,
				signal: opts.signal,
			})) as { content?: unknown; structuredContent?: Record<string, unknown>; isError?: boolean }
			const text = firstText(res.content)
			if (res.isError) throw new DexiToolError(text || `${name} failed`)
			if (res.structuredContent && typeof res.structuredContent === "object") return res.structuredContent
			if (text) {
				try {
					const parsed = JSON.parse(text)
					if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
				} catch {
					// plain text tool result
				}
				return { text }
			}
			return {}
		}

		try {
			return await attempt()
		} catch (err) {
			const translated = this.translate(err)
			if (translated instanceof DexiAuthError || translated instanceof DexiToolError) throw translated
			// Transport hiccup: rebuild once and retry.
			log.debug(`callTool ${name} failed (${translated.message}); reconnecting once`)
			await this.reset()
			try {
				return await attempt()
			} catch (err2) {
				await this.reset()
				throw this.translate(err2)
			}
		}
	}

	async close(): Promise<void> {
		await this.reset()
	}
}

function firstText(content: unknown): string {
	if (!Array.isArray(content)) return ""
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const t = (block as { text?: unknown }).text
			if (typeof t === "string") return t
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// Typed helpers over the Dexi MCP tools (backend/app/mcp/tools.py). Every
// call passes an `intent` sentence for Dexi's aggregate tool analytics; args
// with undefined values are stripped before the wire, so optional flags such
// as full_text/since only travel when set.
// ---------------------------------------------------------------------------

export function withUrl<T extends { id?: unknown }>(item: T): T & { url?: string } {
	if (item && typeof item.id === "string") return { ...item, url: noteUrl(item.id) }
	return item
}

function items(res: Record<string, unknown>): NoteItem[] {
	const list = Array.isArray(res.items) ? (res.items as NoteItem[]) : []
	return list.map((i) => withUrl(i))
}

export type SearchMode = "hybrid" | "semantic" | "keyword"

export const dexi = {
	async semanticSearch(api: DexiApi, query: string, size: number, opts: ToolCallOptions & { fullText?: boolean } = {}) {
		const res = await api.callTool(
			"semantic_search",
			{ query: query.slice(0, 500), size, full_text: opts.fullText || undefined },
			opts,
		)
		return items(res)
	},

	async searchNotes(api: DexiApi, query: string, size: number, opts: ToolCallOptions & { fullText?: boolean; page?: number } = {}) {
		const res = await api.callTool(
			"search_notes",
			{ query: query.slice(0, 200), size, page: opts.page, full_text: opts.fullText || undefined },
			opts,
		)
		return { items: items(res), total: typeof res.total === "number" ? res.total : undefined }
	},

	/** Hermes-style hybrid search: semantic order first, keyword-only hits appended, tagged with `match`. */
	async search(
		api: DexiApi,
		query: string,
		opts: ToolCallOptions & { mode?: SearchMode; size?: number; fullText?: boolean } = {},
	): Promise<{ items: Array<NoteItem & { match: "semantic" | "keyword" | "both" }>; mode: SearchMode }> {
		const mode = opts.mode ?? "hybrid"
		const size = opts.size ?? 10
		const merged = new Map<string, NoteItem & { match: "semantic" | "keyword" | "both" }>()
		if (mode !== "keyword") {
			for (const it of await dexi.semanticSearch(api, query, size, opts)) merged.set(it.id, { ...it, match: "semantic" })
		}
		if (mode !== "semantic") {
			const kw = await dexi.searchNotes(api, query, size, opts)
			for (const it of kw.items) {
				const prev = merged.get(it.id)
				if (prev) prev.match = "both"
				else merged.set(it.id, { ...it, match: "keyword" })
			}
		}
		return { items: [...merged.values()].slice(0, size), mode }
	},

	async listNotes(
		api: DexiApi,
		params: {
			source?: string
			tag?: string
			folder?: string
			period?: string
			since?: string
			sort?: string
			page?: number
			size?: number
			fullText?: boolean
		},
		opts: ToolCallOptions = {},
	) {
		const res = await api.callTool(
			"list_notes",
			{
				source: params.source,
				tag: params.tag,
				folder: params.folder,
				period: params.period,
				since: params.since,
				sort: params.sort,
				page: params.page,
				size: params.size,
				full_text: params.fullText || undefined,
			},
			opts,
		)
		return { items: items(res), total: typeof res.total === "number" ? res.total : undefined, page: res.page }
	},

	async getNote(api: DexiApi, noteId: string, opts: ToolCallOptions = {}) {
		return withUrl((await api.callTool("get_note", { note_id: noteId }, opts)) as NoteItem)
	},

	async createNote(api: DexiApi, title: string, text: string, opts: ToolCallOptions = {}) {
		return withUrl((await api.callTool("create_note", { title, text }, opts)) as NoteItem)
	},

	async appendNote(api: DexiApi, noteId: string, text: string, opts: ToolCallOptions = {}) {
		return withUrl(
			(await api.callTool("update_note", { note_id: noteId, text, mode: "append" }, opts)) as NoteItem,
		)
	},

	async listTags(api: DexiApi, limit = 50, opts: ToolCallOptions = {}) {
		const res = await api.callTool("list_tags", { kind: "hashtag", limit }, opts)
		return Array.isArray(res.tags) ? (res.tags as Array<{ tag: string; count: number }>) : []
	},

	async listFolders(api: DexiApi, opts: ToolCallOptions = {}) {
		const res = await api.callTool("list_folders", {}, opts)
		return {
			folders: Array.isArray(res.folders) ? (res.folders as Array<{ name: string; note_count: number }>) : [],
			unfiled_count: typeof res.unfiled_count === "number" ? res.unfiled_count : undefined,
		}
	},

	async dueReviews(api: DexiApi, limit = 10, opts: ToolCallOptions = {}) {
		const res = await api.callTool("get_due_reviews", { limit }, opts)
		return {
			items: (Array.isArray(res.items) ? (res.items as NoteItem[]) : []).map((i) => withUrl(i)),
			due_count: typeof res.due_count === "number" ? res.due_count : undefined,
		}
	},

	async gradeReview(api: DexiApi, noteId: string, grade: number, opts: ToolCallOptions = {}) {
		return withUrl((await api.callTool("grade_review", { note_id: noteId, grade }, opts)) as NoteItem)
	},
}
