import { describe, expect, it } from "vitest"
import { DEFAULTS, DEFAULT_MCP_URL, interpolateEnv, normalizeTag, parseConfig } from "../src/config.js"

describe("parseConfig", () => {
	it("returns defaults for empty/invalid input", () => {
		expect(parseConfig(undefined, {})).toEqual(DEFAULTS)
		expect(parseConfig(null, {})).toEqual(DEFAULTS)
		expect(parseConfig("nope", {})).toEqual(DEFAULTS)
		expect(parseConfig([1], {})).toEqual(DEFAULTS)
	})

	it("reads config values and coerces types", () => {
		const c = parseConfig(
			{ autoRecall: false, recallResults: "7", recallMinSimilarity: 0.7, sessionDigest: true, digestTag: "Open-Claw", readOnly: "yes", debug: 1 },
			{},
		)
		expect(c.autoRecall).toBe(false)
		expect(c.recallResults).toBe(7)
		expect(c.recallMinSimilarity).toBe(0.7)
		expect(c.sessionDigest).toBe(true)
		expect(c.digestTag).toBe("#open_claw")
		expect(c.readOnly).toBe(true)
		expect(c.debug).toBe(false) // 1 is not a recognised boolean → default
	})

	it("env vars win over config", () => {
		const c = parseConfig(
			{ mcpUrl: "https://example.test/mcp", autoRecall: true, recallResults: 3 },
			{ DEXI_MCP_URL: "http://localhost:8001/mcp/", DEXI_AUTO_RECALL: "false", DEXI_RECALL_RESULTS: "9", DEXI_TOOL_TIMEOUT_MS: "5000" },
		)
		expect(c.mcpUrl).toBe("http://localhost:8001/mcp")
		expect(c.autoRecall).toBe(false)
		expect(c.recallResults).toBe(9)
		expect(c.toolTimeoutMs).toBe(5000)
	})

	it("falls back to the default MCP URL for junk", () => {
		expect(parseConfig({ mcpUrl: "ftp://x" }, {}).mcpUrl).toBe(DEFAULT_MCP_URL)
		expect(parseConfig({ mcpUrl: "not a url" }, {}).mcpUrl).toBe(DEFAULT_MCP_URL)
		expect(parseConfig({ mcpUrl: "" }, {}).mcpUrl).toBe(DEFAULT_MCP_URL)
	})

	it("interpolates ${ENV} in the MCP URL and leaves unknown vars alone", () => {
		expect(parseConfig({ mcpUrl: "https://${DEXI_HOST}/mcp" }, { DEXI_HOST: "mcp.example.test" }).mcpUrl).toBe("https://mcp.example.test/mcp")
		expect(interpolateEnv("a ${NOPE} b", {})).toBe("a ${NOPE} b")
	})

	it("clamps ranges", () => {
		const c = parseConfig({ recallResults: 99, recallMinSimilarity: 5, digestIdleMinutes: 0, recallTimeoutMs: 1, toolTimeoutMs: 1 }, {})
		expect(c.recallResults).toBe(20)
		expect(c.recallMinSimilarity).toBe(1)
		expect(c.digestIdleMinutes).toBe(1)
		expect(c.recallTimeoutMs).toBe(200)
		expect(c.toolTimeoutMs).toBe(1000)
	})
})

describe("normalizeTag", () => {
	it("keeps Dexi's \\w hashtag syntax", () => {
		expect(normalizeTag("#OpenClaw")).toBe("#openclaw")
		expect(normalizeTag("open claw!")).toBe("#open_claw")
		expect(normalizeTag("##a-b")).toBe("#a_b")
		expect(normalizeTag("")).toBe("#openclaw")
		expect(normalizeTag("###")).toBe("#openclaw")
	})
})
