/**
 * Slash commands (bypass the LLM): /remember, /recall, /dexi-digest.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry"
import { DexiAuthError, LOGIN_HINT } from "./auth/provider.js"
import type { SessionCapture } from "./capture.js"
import { type DexiApi, dexi } from "./client.js"
import type { DexiConfig } from "./config.js"
import { log } from "./logger.js"
import { firstLine, stripInboundMetadata } from "./text.js"

const NOT_CONNECTED = `Dexi is not connected — ${LOGIN_HINT} on the machine running OpenClaw.`

function errText(err: unknown): string {
	if (err instanceof DexiAuthError) return err.message
	return `Dexi request failed: ${err instanceof Error ? err.message : String(err)}`
}

export function registerCommands(
	api: OpenClawPluginApi,
	client: DexiApi,
	cfg: DexiConfig,
	capture: SessionCapture,
): void {
	if (!cfg.readOnly) {
		api.registerCommand({
			name: "remember",
			description: "Save a note to Dexi: /remember <text> (first line becomes the title; #hashtags become tags)",
			acceptsArgs: true,
			requireAuth: true,
			handler: async (ctx) => {
				const raw = stripInboundMetadata(ctx.args?.trim() ?? "")
				if (!raw) return { text: "Usage: /remember <text to save>" }
				if (!client.isConnected()) return { text: NOT_CONNECTED }
				const [head, ...rest] = raw.split("\n")
				const title = firstLine(head ?? raw, 80)
				const body = rest.join("\n").trim() || raw
				try {
					const note = await dexi.createNote(client, title, body, { intent: "/remember command", timeoutMs: cfg.toolTimeoutMs })
					return { text: `Saved to Dexi: "${note.title ?? title}"\n${note.url ?? ""}`.trim() }
				} catch (err) {
					log.warn("/remember failed", err)
					return { text: errText(err) }
				}
			},
		})
	}

	api.registerCommand({
		name: "recall",
		description: "Search your Dexi notes: /recall <query>",
		acceptsArgs: true,
		requireAuth: true,
		handler: async (ctx) => {
			const query = stripInboundMetadata(ctx.args?.trim() ?? "")
			if (!query) return { text: "Usage: /recall <search query>" }
			if (!client.isConnected()) return { text: NOT_CONNECTED }
			try {
				const res = await dexi.search(client, query, { size: cfg.recallResults, intent: "/recall command", timeoutMs: cfg.toolTimeoutMs })
				if (res.items.length === 0) return { text: `No Dexi notes found for: "${query}"` }
				const lines = res.items.map((it, i) => {
					const snippet = (it.snippet || "").replace(/\s+/g, " ").trim()
					return `${i + 1}. ${it.title || "(untitled)"}${it.url ? ` — ${it.url}` : ""}${snippet ? `\n   ${snippet.slice(0, 200)}` : ""}`
				})
				return { text: `Found ${res.items.length} note${res.items.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}` }
			} catch (err) {
				log.warn("/recall failed", err)
				return { text: errText(err) }
			}
		},
	})

	api.registerCommand({
		name: "dexi-digest",
		description: "Write this session's digest note to Dexi now (requires sessionDigest: true)",
		acceptsArgs: false,
		requireAuth: true,
		handler: async (ctx) => {
			if (!capture.enabled) {
				return { text: "Session digests are off. Set plugins.entries.openclaw-dexi.config.sessionDigest to true (and readOnly to false) to enable them." }
			}
			if (!client.isConnected()) return { text: NOT_CONNECTED }
			const key = ctx.sessionKey || ctx.sessionId || "default"
			const state = capture.inspect(key)
			if (!state || state.turns === 0) return { text: "Nothing to digest yet in this session." }
			try {
				const noteId = await capture.flush(key, { keepBuffer: true, reason: "/dexi-digest" })
				return { text: noteId ? `Digest written to Dexi (note ${noteId}).` : "Nothing new to add to the digest." }
			} catch (err) {
				return { text: errText(err) }
			}
		},
	})
}
