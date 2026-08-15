/**
 * MemoryPluginRuntime for the memory slot: what `openclaw status`, `doctor`,
 * the Control UI memory panel and the gateway `memory-search` RPC talk to
 * while Dexi is the memory plugin. Search maps to Dexi's semantic_search,
 * readFile to get_note (paths are `dexi/<note-id>`), sync is a no-op (Dexi is
 * remote), and the embedding probe is a cheap list_folders round-trip.
 */
import type { MemoryPluginCapability } from "openclaw/plugin-sdk/core"
import { type DexiApi, dexi } from "./client.js"
import type { DexiConfig } from "./config.js"
import { log } from "./logger.js"

type MemoryPluginRuntime = NonNullable<MemoryPluginCapability["runtime"]>
type ManagerResult = Awaited<ReturnType<MemoryPluginRuntime["getMemorySearchManager"]>>
export type MemorySearchManager = NonNullable<ManagerResult["manager"]>
type SearchResult = Awaited<ReturnType<MemorySearchManager["search"]>>[number]

export const MEMORY_PATH_PREFIX = "dexi/"

export function notePath(id: string): string {
	return `${MEMORY_PATH_PREFIX}${id}`
}

export function noteIdFromPath(relPath: string): string | null {
	const p = relPath.trim().replace(/^\/+/, "")
	if (!p.startsWith(MEMORY_PATH_PREFIX)) return null
	const id = p.slice(MEMORY_PATH_PREFIX.length).replace(/\.md$/, "")
	return id || null
}

export function createSearchManager(api: DexiApi, cfg: DexiConfig): MemorySearchManager {
	let lastProbe: { ok: boolean; error?: string; checkedAtMs: number } | null = null
	return {
		async search(query, opts) {
			if (!api.isConnected()) return []
			const max = Math.max(1, Math.min(50, opts?.maxResults ?? cfg.recallResults))
			const min = opts?.minScore ?? 0
			try {
				const items = await dexi.semanticSearch(api, query, max, {
					timeoutMs: cfg.toolTimeoutMs,
					signal: opts?.signal,
					intent: "memory search from OpenClaw",
				})
				const out: SearchResult[] = []
				for (const it of items) {
					const score = Number(it.similarity ?? 0)
					if (score < min) continue
					out.push({
						path: notePath(it.id),
						startLine: 1,
						endLine: 1,
						score,
						vectorScore: score,
						snippet: [it.title, it.snippet].filter(Boolean).join(" — "),
						source: "memory",
						citation: it.url,
					})
				}
				return out
			} catch (err) {
				log.debug(`memory search failed (${err instanceof Error ? err.message : String(err)})`)
				return []
			}
		},

		async readFile(params) {
			const id = noteIdFromPath(params.relPath)
			if (!id) throw new Error(`not a Dexi memory path: ${params.relPath}`)
			const note = await dexi.getNote(api, id, { intent: "read note from OpenClaw memory panel" })
			const header = `# ${note.title || "(untitled)"}\n${note.url ?? ""}\n\n`
			const body = typeof note.text === "string" ? note.text : (note.snippet ?? "")
			const full = header + body
			const lines = full.split("\n")
			const from = Math.max(1, params.from ?? 1)
			const count = params.lines ?? lines.length
			const slice = lines.slice(from - 1, from - 1 + count)
			const nextFrom = from - 1 + count < lines.length ? from + count : undefined
			return {
				text: slice.join("\n"),
				path: params.relPath,
				truncated: nextFrom !== undefined,
				from,
				lines: slice.length,
				nextFrom,
			}
		},

		status() {
			return {
				backend: "builtin" as const,
				provider: "dexi",
				model: "dexi-remote",
				requestedProvider: "dexi",
				files: 0,
				chunks: 0,
				sources: ["memory" as const],
				vector: { enabled: true, available: api.isConnected() },
				custom: {
					mcpUrl: api.mcpUrl,
					connected: api.isConnected(),
					transport: "remote",
					readOnly: cfg.readOnly,
				},
			}
		},

		getCachedEmbeddingAvailability() {
			return lastProbe ? { ...lastProbe, checked: true, cached: true } : null
		},

		async probeEmbeddingAvailability() {
			if (!api.isConnected()) {
				lastProbe = { ok: false, error: "Dexi is not connected — run `openclaw dexi login`", checkedAtMs: Date.now() }
				return { ...lastProbe, checked: true }
			}
			try {
				await dexi.listFolders(api, { timeoutMs: 15_000, intent: "connection probe" })
				lastProbe = { ok: true, checkedAtMs: Date.now() }
			} catch (err) {
				lastProbe = { ok: false, error: err instanceof Error ? err.message : String(err), checkedAtMs: Date.now() }
			}
			return { ...lastProbe, checked: true }
		},

		async probeVectorStoreAvailability() {
			return api.isConnected()
		},

		async probeVectorAvailability() {
			return api.isConnected()
		},

		async sync() {
			// Remote store — nothing to index locally.
		},

		async close() {},
	}
}

export function buildMemoryRuntime(api: DexiApi, cfg: DexiConfig): MemoryPluginRuntime {
	let manager: MemorySearchManager | undefined
	return {
		async getMemorySearchManager() {
			manager ??= createSearchManager(api, cfg)
			return { manager, debug: { backend: "builtin" } }
		},
		resolveMemoryBackendConfig() {
			return { backend: "builtin" as const }
		},
		async closeMemorySearchManager() {},
		async closeAllMemorySearchManagers() {},
	}
}
