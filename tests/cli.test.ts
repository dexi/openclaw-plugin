import { describe, expect, it } from "vitest"
import { applySetupConfig } from "../src/cli.js"
import { PLUGIN_ID } from "../src/config.js"
import { TOOL_NAMES } from "../src/tools.js"

describe("applySetupConfig", () => {
	it("enables the entry with hook permissions, claims the memory slot, and allowlists tools via alsoAllow", () => {
		const draft: Record<string, unknown> = {}
		const { warnings } = applySetupConfig(draft, { sessionDigest: true, digestTag: "My Tag" })
		expect(warnings).toEqual([])
		const plugins = draft.plugins as Record<string, Record<string, unknown>>
		expect(plugins.entries![PLUGIN_ID]).toEqual({
			enabled: true,
			hooks: { allowPromptInjection: true, allowConversationAccess: true },
			config: { sessionDigest: true, digestTag: "#my_tag" },
		})
		expect(plugins.slots!.memory).toBe(PLUGIN_ID)
		expect((draft.tools as { alsoAllow: string[] }).alsoAllow).toEqual([...TOOL_NAMES])
		expect(draft.tools).not.toHaveProperty("allow")
	})

	it("never sets both tools.allow and tools.alsoAllow; appends to an existing allow", () => {
		const draft: Record<string, unknown> = { tools: { allow: ["exec", "dexi_search"] } }
		applySetupConfig(draft)
		const tools = draft.tools as { allow: string[]; alsoAllow?: string[] }
		expect(tools.allow).toEqual(["exec", ...TOOL_NAMES])
		expect(tools.alsoAllow).toBeUndefined()
	})

	it("preserves existing config values, appends to plugins.allow, and warns about slot/mcp overlaps", () => {
		const draft: Record<string, unknown> = {
			plugins: { allow: ["telegram"], entries: { [PLUGIN_ID]: { enabled: false, config: { recallResults: 3 } } }, slots: { memory: "memory-lancedb" } },
			mcp: { servers: { dexi: { url: "https://mcp.dexi.net/mcp" } } },
		}
		const { warnings } = applySetupConfig(draft, { readOnly: true })
		const plugins = draft.plugins as Record<string, Record<string, unknown>>
		expect(plugins.allow).toEqual(["telegram", PLUGIN_ID])
		expect((plugins.entries![PLUGIN_ID] as { config: unknown }).config).toEqual({ recallResults: 3, readOnly: true })
		expect(plugins.slots!.memory).toBe(PLUGIN_ID)
		expect(warnings.some((w) => w.includes("memory-lancedb"))).toBe(true)
		expect(warnings.some((w) => w.includes("mcp.servers.dexi"))).toBe(true)
	})
})
