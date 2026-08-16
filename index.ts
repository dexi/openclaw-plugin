/**
 * Dexi memory plugin for OpenClaw.
 *
 * Your Dexi notes library (typed notes, clipped web pages, emailed articles,
 * RSS entries) as the agent's long-term memory: auto-recall before each turn,
 * compact dexi_* tools, /remember + /recall commands, an optional per-session
 * digest note, and an `openclaw dexi` CLI. Talks to Dexi's MCP server over
 * streamable HTTP with OAuth 2.1 (no API keys) — sign in with
 * `openclaw dexi login`; manage the grant in Dexi → Settings → Connected apps.
 *
 * `register(api)` must stay free of I/O: OpenClaw also loads plugins in
 * discovery / CLI-metadata modes. Network happens lazily inside hooks, tools,
 * commands, and CLI actions.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry"
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry"
import { OAuthStore, defaultStateDir } from "./src/auth/store.js"
import { SessionCapture } from "./src/capture.js"
import { registerCli } from "./src/cli.js"
import { FileDigestStateStore } from "./src/digest-state.js"
import { DexiClient } from "./src/client.js"
import { registerCommands } from "./src/commands.js"
import { PLUGIN_ID, PLUGIN_NAME, dexiConfigSchema, parseConfig } from "./src/config.js"
import { buildAgentEndHandler, buildBeforeCompactionHandler, buildRecallHandler, buildSessionEndHandler } from "./src/hooks.js"
import { initLogger, log } from "./src/logger.js"
import { buildPromptSection } from "./src/prompt.js"
import { buildMemoryRuntime } from "./src/runtime.js"
import { registerTools } from "./src/tools.js"

export const PLUGIN_VERSION = "0.1.1"

function resolveStateDir(api: OpenClawPluginApi): string {
	try {
		const fn = api.runtime?.state?.resolveStateDir
		if (typeof fn === "function") return fn(process.env)
	} catch {
		// fall through
	}
	return defaultStateDir()
}

export default definePluginEntry({
	id: PLUGIN_ID,
	name: PLUGIN_NAME,
	description: "Dexi notes library as OpenClaw's long-term memory (auto-recall, dexi_* tools, /remember, session digest)",
	kind: "memory",
	configSchema: dexiConfigSchema,

	register(api: OpenClawPluginApi) {
		const cfg = parseConfig(api.pluginConfig)
		initLogger(api.logger, cfg.debug)

		const stateDir = resolveStateDir(api)
		const store = OAuthStore.forStateDir(stateDir)
		const client = new DexiClient({
			mcpUrl: cfg.mcpUrl,
			store,
			readOnly: cfg.readOnly,
			toolTimeoutMs: cfg.toolTimeoutMs,
			clientVersion: PLUGIN_VERSION,
		})
		const capture = new SessionCapture(client, cfg, FileDigestStateStore.forStateDir(stateDir))

		// Memory slot: prompt section + search runtime (Control UI / status / doctor).
		const memoryRuntime = buildMemoryRuntime(client, cfg)
		const promptBuilder = (params: { availableTools: Set<string> }) => buildPromptSection(cfg, params)
		const flushPlanResolver = () => null // Dexi never runs the host's markdown memory-flush turn
		if (typeof api.registerMemoryCapability === "function") {
			api.registerMemoryCapability({ promptBuilder, flushPlanResolver, runtime: memoryRuntime })
		} else {
			// Pre-capability hosts (deprecated split registration).
			api.registerMemoryRuntime?.(memoryRuntime)
			api.registerMemoryPromptSection?.(promptBuilder)
			api.registerMemoryFlushPlan?.(flushPlanResolver)
		}

		registerTools(api, client, cfg)
		registerCommands(api, client, cfg, capture)
		registerCli(api, {
			store,
			cfg,
			version: PLUGIN_VERSION,
			makeClient: (opts) =>
				new DexiClient({
					mcpUrl: cfg.mcpUrl,
					store,
					readOnly: cfg.readOnly,
					toolTimeoutMs: opts?.timeoutMs ?? cfg.toolTimeoutMs,
					clientVersion: PLUGIN_VERSION,
				}),
		})

		if (cfg.autoRecall) {
			api.on("before_prompt_build", buildRecallHandler(client, cfg), { timeoutMs: cfg.recallTimeoutMs + 1000 })
		}
		if (cfg.sessionDigest && !cfg.readOnly) {
			api.on("agent_end", buildAgentEndHandler(capture))
			api.on("session_end", buildSessionEndHandler(capture))
			api.on("before_compaction", buildBeforeCompactionHandler(capture))
		}

		api.registerService({
			id: PLUGIN_ID,
			start: () => {
				log.info(
					client.isConnected()
						? `connected to ${cfg.mcpUrl}${cfg.readOnly ? " (read-only)" : ""}${cfg.sessionDigest ? `, session digest ${cfg.digestTag}` : ""}`
						: `not signed in — run \`openclaw dexi login\` (${cfg.mcpUrl})`,
				)
			},
			stop: async () => {
				await capture.stop()
				await client.close()
			},
		})
	},
})
