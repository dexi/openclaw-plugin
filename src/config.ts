/**
 * Plugin configuration: `plugins.entries.openclaw-dexi.config` in
 * ~/.openclaw/openclaw.json, with `DEXI_<KEY>` environment overrides and
 * `${ENV_VAR}` interpolation inside string values.
 *
 * Mirrors hermes-plugin/hermes_dexi/config.py (same keys, camelCased). No
 * secrets live here — OAuth tokens are stored by auth/store.ts.
 */

export const PLUGIN_ID = "openclaw-dexi"
export const PLUGIN_NAME = "Dexi"
export const DEFAULT_MCP_URL = "https://mcp.dexi.net/mcp"
export const APP_URL = "https://app.dexi.net"

export type DexiConfig = {
	mcpUrl: string
	autoRecall: boolean
	recallResults: number
	recallMinSimilarity: number
	sessionDigest: boolean
	digestTag: string
	digestIdleMinutes: number
	readOnly: boolean
	recallTimeoutMs: number
	toolTimeoutMs: number
	debug: boolean
}

export const DEFAULTS: DexiConfig = {
	mcpUrl: DEFAULT_MCP_URL,
	autoRecall: true,
	recallResults: 5,
	recallMinSimilarity: 0.55,
	sessionDigest: false,
	digestTag: "#openclaw",
	digestIdleMinutes: 30,
	readOnly: false,
	recallTimeoutMs: 2500,
	toolTimeoutMs: 30_000,
	debug: false,
}

const BOOL_KEYS = new Set<keyof DexiConfig>([
	"autoRecall",
	"sessionDigest",
	"readOnly",
	"debug",
])
const INT_KEYS = new Set<keyof DexiConfig>([
	"recallResults",
	"digestIdleMinutes",
	"recallTimeoutMs",
	"toolTimeoutMs",
])
const FLOAT_KEYS = new Set<keyof DexiConfig>(["recallMinSimilarity"])

const ALLOWED_KEYS = Object.keys(DEFAULTS) as Array<keyof DexiConfig>

/** `${VAR}` → process.env.VAR; unknown vars are left untouched. */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
		const v = env[name]
		return v === undefined ? whole : v
	})
}

/** Dexi hashtags are `\w` runs: `#Open-Claw` → `#open_claw`. Always returns a `#`-prefixed tag. */
export function normalizeTag(raw: unknown, fallback = DEFAULTS.digestTag): string {
	const s = typeof raw === "string" ? raw.trim() : ""
	const body = s.replace(/^#+/, "").replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase()
	return body ? `#${body}` : fallback
}

function envKey(key: string): string {
	return `DEXI_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`
}

function coerceBool(v: unknown, fallback: boolean): boolean {
	if (typeof v === "boolean") return v
	if (typeof v === "string") {
		const s = v.trim().toLowerCase()
		if (["1", "true", "yes", "on"].includes(s)) return true
		if (["0", "false", "no", "off", ""].includes(s)) return false
	}
	return fallback
}

function coerceNumber(v: unknown, fallback: number, integer: boolean): number {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : Number.NaN
	if (!Number.isFinite(n)) return fallback
	return integer ? Math.trunc(n) : n
}

function normalizeMcpUrl(v: unknown, env: NodeJS.ProcessEnv): string {
	if (typeof v !== "string" || !v.trim()) return DEFAULT_MCP_URL
	const trimmed = interpolateEnv(v.trim(), env).replace(/\/+$/, "")
	try {
		const url = new URL(trimmed)
		if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_MCP_URL
		return trimmed
	} catch {
		return DEFAULT_MCP_URL
	}
}

/**
 * Parse the raw plugin config. Precedence per key: env var `DEXI_<KEY>` >
 * config value > default. Unknown keys are ignored (OpenClaw's own schema
 * validation rejects them upstream via `additionalProperties: false`).
 */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): DexiConfig {
	const cfg =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {}
	const out: Record<string, unknown> = { ...DEFAULTS }
	for (const key of ALLOWED_KEYS) {
		const fromEnv = env[envKey(key)]
		let value: unknown = fromEnv !== undefined && fromEnv !== "" ? fromEnv : cfg[key]
		if (value === undefined || value === null) continue
		if (typeof value === "string" && key !== "mcpUrl") value = interpolateEnv(value, env)
		if (BOOL_KEYS.has(key)) out[key] = coerceBool(value, DEFAULTS[key] as boolean)
		else if (INT_KEYS.has(key)) out[key] = coerceNumber(value, DEFAULTS[key] as number, true)
		else if (FLOAT_KEYS.has(key)) out[key] = coerceNumber(value, DEFAULTS[key] as number, false)
		else out[key] = value
	}
	const result = out as DexiConfig
	result.mcpUrl = normalizeMcpUrl(env.DEXI_MCP_URL || cfg.mcpUrl, env)
	result.digestTag = normalizeTag(result.digestTag)
	result.recallResults = Math.min(20, Math.max(1, result.recallResults))
	result.recallMinSimilarity = Math.min(1, Math.max(0, result.recallMinSimilarity))
	result.digestIdleMinutes = Math.max(1, result.digestIdleMinutes)
	result.recallTimeoutMs = Math.max(200, result.recallTimeoutMs)
	result.toolTimeoutMs = Math.max(1000, result.toolTimeoutMs)
	return result
}

/** JSON Schema shared by openclaw.plugin.json and the runtime configSchema. */
export const configJsonSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		mcpUrl: { type: "string" },
		autoRecall: { type: "boolean" },
		recallResults: { type: "number", minimum: 1, maximum: 20 },
		recallMinSimilarity: { type: "number", minimum: 0, maximum: 1 },
		sessionDigest: { type: "boolean" },
		digestTag: { type: "string" },
		digestIdleMinutes: { type: "number", minimum: 1 },
		readOnly: { type: "boolean" },
		recallTimeoutMs: { type: "number", minimum: 200 },
		toolTimeoutMs: { type: "number", minimum: 1000 },
		debug: { type: "boolean" },
	},
} as const

export const dexiConfigSchema = {
	jsonSchema: configJsonSchema,
	parse: (value: unknown) => parseConfig(value),
}

export function noteUrl(id: string): string {
	return `${APP_URL}/dashboard/notes/${id}`
}
