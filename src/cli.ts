/**
 * `openclaw dexi …` — setup | login | logout | status | search | save
 *
 * `setup` edits openclaw.json through OpenClaw's own config writer
 * (api.runtime.config.mutateConfigFile) so validation/formatting stay the
 * host's, then runs `login`. Everything else is a thin front over the same
 * DexiClient the gateway uses.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry"
import { login, logout } from "./auth/login.js"
import { LOGIN_HINT } from "./auth/provider.js"
import type { OAuthStore } from "./auth/store.js"
import { DexiClient, dexi } from "./client.js"
import { type DexiConfig, PLUGIN_ID, normalizeTag } from "./config.js"
import { TOOL_NAMES } from "./tools.js"

type AnyRecord = Record<string, unknown>

function obj(parent: AnyRecord, key: string): AnyRecord {
	const v = parent[key]
	if (v && typeof v === "object" && !Array.isArray(v)) return v as AnyRecord
	const fresh: AnyRecord = {}
	parent[key] = fresh
	return fresh
}

function uniq(list: unknown, add: readonly string[]): string[] {
	const cur = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []
	return [...new Set([...cur, ...add])]
}

export type SetupOptions = {
	readOnly?: boolean
	sessionDigest?: boolean
	digestTag?: string
	mcpUrl?: string
	autoRecall?: boolean
}

/**
 * Pure config mutation for `setup` — exported for tests. Enables the plugin
 * entry with the hook permissions the memory hooks need, claims the memory
 * slot, and allowlists the tools without ever setting both `tools.allow` and
 * `tools.alsoAllow` (OpenClaw rejects that combination).
 */
export function applySetupConfig(draft: AnyRecord, opts: SetupOptions = {}): { warnings: string[] } {
	const warnings: string[] = []
	const plugins = obj(draft, "plugins")
	const entries = obj(plugins, "entries")
	const slots = obj(plugins, "slots")
	const entry = obj(entries, PLUGIN_ID)
	entry.enabled = true
	const hooks = obj(entry, "hooks")
	hooks.allowPromptInjection = true
	hooks.allowConversationAccess = true
	const config = obj(entry, "config")
	if (opts.readOnly !== undefined) config.readOnly = opts.readOnly
	if (opts.sessionDigest !== undefined) config.sessionDigest = opts.sessionDigest
	if (opts.autoRecall !== undefined) config.autoRecall = opts.autoRecall
	if (opts.digestTag) config.digestTag = normalizeTag(opts.digestTag)
	if (opts.mcpUrl) config.mcpUrl = opts.mcpUrl
	const previousSlot = slots.memory
	slots.memory = PLUGIN_ID
	if (previousSlot && previousSlot !== PLUGIN_ID && previousSlot !== "memory-core") {
		warnings.push(`memory slot was "${String(previousSlot)}" — now "${PLUGIN_ID}" (only one memory plugin can be active).`)
	}
	// Plugin allowlist (only relevant when the user pinned one).
	if (Array.isArray(plugins.allow)) plugins.allow = uniq(plugins.allow, [PLUGIN_ID])
	// Tool allowlist: append to whichever list exists; alsoAllow if neither.
	const tools = obj(draft, "tools")
	if (Array.isArray(tools.allow)) tools.allow = uniq(tools.allow, TOOL_NAMES)
	else tools.alsoAllow = uniq(tools.alsoAllow, TOOL_NAMES)
	const mcp = draft.mcp as AnyRecord | undefined
	const servers = mcp && typeof mcp === "object" ? (mcp.servers as AnyRecord | undefined) : undefined
	if (servers && typeof servers === "object" && "dexi" in servers) {
		warnings.push(
			"mcp.servers.dexi is also configured — the model will see both dexi__* MCP tools and the plugin's dexi_* tools. Keep one (openclaw mcp unset dexi) to avoid duplicates.",
		)
	}
	return { warnings }
}

export type CliDeps = {
	store: OAuthStore
	cfg: DexiConfig
	version: string
	makeClient: (opts?: { timeoutMs?: number }) => DexiClient
}

export function registerCli(api: OpenClawPluginApi, deps: CliDeps): void {
	api.registerCli(
		({ program }) => {
			const cmd = program.command("dexi").description("Dexi memory plugin — connect your notes library to OpenClaw")
			const print = (line: string) => console.log(line)

			cmd
				.command("setup")
				.description("Enable the plugin, make it the memory slot, then sign in to Dexi")
				.option("--read-only", "request read-only access (notes:read); hides save/append tools")
				.option("--session-digest", "write one digest note per session (off by default)")
				.option("--digest-tag <tag>", "tag for digest notes (default #openclaw)")
				.option("--mcp-url <url>", "Dexi MCP endpoint (default https://mcp.dexi.net/mcp)")
				.option("--no-login", "only write config; skip the OAuth login")
				.option("--no-browser", "print the authorize URL without opening a browser")
				.action(async (opts: { readOnly?: boolean; sessionDigest?: boolean; digestTag?: string; mcpUrl?: string; login: boolean; browser: boolean }) => {
					const setupOpts: SetupOptions = {
						readOnly: opts.readOnly,
						sessionDigest: opts.sessionDigest,
						digestTag: opts.digestTag,
						mcpUrl: opts.mcpUrl,
					}
					let warnings: string[] = []
					const mutate = api.runtime?.config?.mutateConfigFile
					if (typeof mutate === "function") {
						const res = await mutate({
							afterWrite: { mode: "none", reason: "openclaw dexi setup — restart the gateway to apply" },
							mutate: (draft: unknown) => applySetupConfig(draft as AnyRecord, setupOpts).warnings,
						})
						warnings = (res.result as string[] | undefined) ?? []
					} else {
						// Metadata-only host: fall back to a direct edit of openclaw.json.
						const fs = await import("node:fs")
						const path = await import("node:path")
						const { defaultStateDir } = await import("./auth/store.js")
						const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(defaultStateDir(), "openclaw.json")
						let draft: AnyRecord = {}
						try {
							draft = JSON.parse(fs.readFileSync(configPath, "utf8")) as AnyRecord
						} catch {
							draft = {}
						}
						warnings = applySetupConfig(draft, setupOpts).warnings
						fs.mkdirSync(path.dirname(configPath), { recursive: true })
						fs.writeFileSync(configPath, `${JSON.stringify(draft, null, 2)}\n`)
					}
					print("✓ Config updated: plugins.entries.openclaw-dexi enabled, plugins.slots.memory = openclaw-dexi")
					for (const w of warnings) print(`  ! ${w}`)
					if (opts.login) {
						const readOnly = opts.readOnly ?? deps.cfg.readOnly
						const mcpUrl = opts.mcpUrl ?? deps.cfg.mcpUrl
						const r = await login({ store: deps.store, mcpUrl, readOnly, io: { print }, openBrowser: opts.browser, clientVersion: deps.version })
						print(`✓ Connected to Dexi (${r.scope}) — ${r.probe}`)
					}
					print("")
					print("Restart the gateway to apply: openclaw gateway restart")
					print("Manage or revoke this connection in Dexi → Settings → Connected apps.")
				})

			cmd
				.command("login")
				.description("Sign in to Dexi (OAuth in the browser, or paste the redirect URL back — works headless)")
				.option("--read-only", "request read-only access (notes:read)")
				.option("--no-browser", "print the authorize URL without opening a browser")
				.option("--code <value>", "finish a pending login with the pasted redirect URL / code")
				.action(async (opts: { readOnly?: boolean; browser: boolean; code?: string }) => {
					const readOnly = opts.readOnly ?? deps.cfg.readOnly
					const r = await login({
						store: deps.store,
						mcpUrl: deps.cfg.mcpUrl,
						readOnly,
						io: { print }, // login opens/closes its own readline when stdin is a TTY
						openBrowser: opts.browser,
						code: opts.code,
						clientVersion: deps.version,
					})
					print(`✓ Connected to Dexi (${r.scope}) — ${r.probe}`)
					print("If the gateway is running, restart it so it picks up the token: openclaw gateway restart")
				})

			cmd
				.command("logout")
				.description("Revoke the Dexi token and forget it locally")
				.action(async () => {
					const r = await logout(deps.store, deps.cfg.mcpUrl)
					print(r.revoked ? "✓ Token revoked and removed." : "✓ Token removed locally (revocation endpoint not reached — revoke in Dexi → Settings → Connected apps if needed).")
				})

			cmd
				.command("status")
				.description("Show config and probe the connection")
				.action(async () => {
					const c = deps.cfg
					print(`Dexi memory plugin ${deps.version}`)
					print(`  mcpUrl: ${c.mcpUrl}`)
					print(`  autoRecall: ${c.autoRecall} (results ${c.recallResults}, min similarity ${c.recallMinSimilarity}, timeout ${c.recallTimeoutMs} ms)`)
					print(`  sessionDigest: ${c.sessionDigest}${c.sessionDigest ? ` (tag ${c.digestTag}, idle ${c.digestIdleMinutes} min)` : ""}`)
					print(`  readOnly: ${c.readOnly}`)
					print(`  tokens: ${deps.store.hasTokens(c.mcpUrl) ? `present (${deps.store.filePath})` : "none"}`)
					const slot = (api.config as { plugins?: { slots?: { memory?: string } } })?.plugins?.slots?.memory
					print(`  memory slot: ${slot ?? "(unset — run openclaw dexi setup)"}${slot && slot !== PLUGIN_ID ? "  ← not this plugin" : ""}`)
					if (!deps.store.hasTokens(c.mcpUrl)) {
						print(`  connection: not signed in — ${LOGIN_HINT}`)
						return
					}
					const client = deps.makeClient({ timeoutMs: 20_000 })
					try {
						const f = await dexi.listFolders(client, { intent: "status probe" })
						print(`  connection: OK — ${f.folders.length} folders, ${f.unfiled_count ?? "?"} unfiled notes`)
					} catch (err) {
						print(`  connection: FAILED — ${err instanceof Error ? err.message : String(err)}`)
						process.exitCode = 1
					} finally {
						await client.close()
					}
				})

			cmd
				.command("search <query...>")
				.description("Search your notes from the terminal")
				.option("-n, --size <n>", "max results", "10")
				.option("--keyword", "keyword-only (default hybrid)")
				.option("--semantic", "semantic-only (default hybrid)")
				.action(async (parts: string[], opts: { size: string; keyword?: boolean; semantic?: boolean }) => {
					const client = deps.makeClient()
					try {
						const res = await dexi.search(client, parts.join(" "), {
							size: Math.max(1, Math.min(50, Number(opts.size) || 10)),
							mode: opts.keyword ? "keyword" : opts.semantic ? "semantic" : "hybrid",
							intent: "cli search",
						})
						if (res.items.length === 0) {
							print("No notes found.")
							return
						}
						res.items.forEach((it, i) => {
							const pct = typeof it.similarity === "number" ? ` ${Math.round(it.similarity * 100)}%` : ""
							print(`${i + 1}. ${it.title || "(untitled)"}${pct} — ${it.url ?? it.id}`)
							if (it.snippet) print(`   ${it.snippet.replace(/\s+/g, " ").slice(0, 200)}`)
						})
					} finally {
						await client.close()
					}
				})

			cmd
				.command("save <text...>")
				.description("Save a note (first line = title; #hashtags become tags)")
				.action(async (parts: string[]) => {
					if (deps.cfg.readOnly) {
						print("This connection is read-only (readOnly: true).")
						process.exitCode = 1
						return
					}
					const raw = parts.join(" ").trim()
					const [head, ...rest] = raw.split("\n")
					const title = (head ?? raw).slice(0, 80)
					const body = rest.join("\n").trim() || raw
					const client = deps.makeClient()
					try {
						const note = await dexi.createNote(client, title, body, { intent: "cli save" })
						print(`Saved "${note.title ?? title}" — ${note.url ?? note.id}`)
					} finally {
						await client.close()
					}
				})
		},
		{ descriptors: [{ name: "dexi", description: "Dexi memory plugin (setup, login, status, search, save)", hasSubcommands: true }] },
	)
}
