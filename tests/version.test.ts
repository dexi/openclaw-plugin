import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PLUGIN_VERSION } from "../index.js"

describe("PLUGIN_VERSION", () => {
	it("matches package.json — it is what the MCP client reports to Dexi, so a stale constant mislabels every connection", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version: string }
		expect(PLUGIN_VERSION).toBe(pkg.version)
	})
})
