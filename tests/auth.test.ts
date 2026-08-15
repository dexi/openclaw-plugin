import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseCallbackInput } from "../src/auth/login.js"
import { DexiAuthError, FileOAuthClientProvider, scopeFor } from "../src/auth/provider.js"
import { OAuthStore, defaultStateDir, oauthStorePath } from "../src/auth/store.js"

const dirs: string[] = []
function tmpStore(): OAuthStore {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dexi-oauth-"))
	dirs.push(dir)
	return OAuthStore.forStateDir(dir)
}
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const URL1 = "http://localhost:8001/mcp"

describe("OAuthStore", () => {
	it("round-trips per server, atomically, mode 0600", () => {
		const store = tmpStore()
		expect(store.hasTokens(URL1)).toBe(false)
		store.update(URL1, { tokens: { access_token: "dxm_a", token_type: "Bearer", refresh_token: "dxr_a" } })
		store.update("https://mcp.dexi.net/mcp", { tokens: { access_token: "dxm_prod", token_type: "Bearer" } })
		expect(store.hasTokens(URL1)).toBe(true)
		expect(store.get(URL1).tokens?.access_token).toBe("dxm_a")
		expect(store.get("https://mcp.dexi.net/mcp").tokens?.access_token).toBe("dxm_prod")
		if (process.platform !== "win32") expect(fs.statSync(store.filePath).mode & 0o777).toBe(0o600)
		store.clear(URL1, ["tokens"])
		expect(store.hasTokens(URL1)).toBe(false)
		expect(store.get("https://mcp.dexi.net/mcp").tokens?.access_token).toBe("dxm_prod")
		store.clear("https://mcp.dexi.net/mcp")
		expect(store.get("https://mcp.dexi.net/mcp")).toEqual({})
	})
	it("survives a corrupt file", () => {
		const store = tmpStore()
		fs.mkdirSync(path.dirname(store.filePath), { recursive: true })
		fs.writeFileSync(store.filePath, "{not json")
		expect(store.get(URL1)).toEqual({})
		store.update(URL1, { scope: "notes:read" })
		expect(store.get(URL1).scope).toBe("notes:read")
	})
	it("resolves the state dir from OPENCLAW_STATE_DIR", () => {
		expect(defaultStateDir({ OPENCLAW_STATE_DIR: "/tmp/oc" })).toBe(path.resolve("/tmp/oc"))
		expect(defaultStateDir({})).toBe(path.join(os.homedir(), ".openclaw"))
		expect(oauthStorePath("/x")).toBe(path.join("/x", "dexi", "oauth.json"))
	})
})

describe("FileOAuthClientProvider", () => {
	it("gateway mode never redirects a browser and reads tokens fresh from disk", () => {
		const store = tmpStore()
		const p = new FileOAuthClientProvider(store, URL1, { kind: "gateway" }, scopeFor(false))
		expect(p.tokens()).toBeUndefined()
		store.update(URL1, { tokens: { access_token: "dxm_x", token_type: "Bearer" } })
		expect(p.tokens()?.access_token).toBe("dxm_x") // another process wrote it
		expect(() => p.redirectToAuthorization(new URL("https://example.test/authorize"))).toThrow(DexiAuthError)
		expect(p.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
		expect(p.clientMetadata.token_endpoint_auth_method).toBe("none")
		expect(p.clientMetadata.scope).toBe("notes:read notes:write")
		expect(scopeFor(true)).toBe("notes:read")
	})
	it("login mode forces re-registration when the stored client used another redirect URI", () => {
		const store = tmpStore()
		store.update(URL1, { client: { client_id: "c1", redirect_uris: ["http://127.0.0.1:1111/callback"] } })
		let seen: URL | undefined
		const p = new FileOAuthClientProvider(store, URL1, { kind: "login", redirectUrl: "http://127.0.0.1:2222/callback", onAuthorizeUrl: (u) => (seen = u) }, "notes:read")
		expect(p.clientInformation()).toBeUndefined()
		p.saveClientInformation({ client_id: "c2", redirect_uris: ["http://127.0.0.1:2222/callback"] })
		expect(p.clientInformation()?.client_id).toBe("c2")
		p.redirectToAuthorization(new URL("https://example.test/authorize?x=1"))
		expect(seen?.toString()).toBe("https://example.test/authorize?x=1")
		expect(p.state()).toBe(p.state())
		expect(p.expectedState).toHaveLength(32)
	})
	it("persists verifier/discovery and invalidates by scope", () => {
		const store = tmpStore()
		const p = new FileOAuthClientProvider(store, URL1, { kind: "gateway" }, "notes:read")
		p.saveCodeVerifier("v1")
		expect(p.codeVerifier()).toBe("v1")
		p.saveDiscoveryState({ authorizationServerUrl: new URL("http://localhost:8001") } as never)
		expect(p.discoveryState()).toBeTruthy()
		p.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r" })
		p.invalidateCredentials("tokens")
		expect(p.tokens()).toBeUndefined()
		expect(p.codeVerifier()).toBe("v1")
		p.invalidateCredentials("all")
		expect(() => p.codeVerifier()).toThrow(DexiAuthError)
	})
})

describe("parseCallbackInput (paste-back)", () => {
	it("accepts a full URL, a query string, or a bare code", () => {
		expect(parseCallbackInput("http://127.0.0.1:46161/callback?code=dxc_abc&state=s1")).toEqual({ code: "dxc_abc", state: "s1", error: undefined, errorDescription: undefined })
		expect(parseCallbackInput("?code=dxc_abc&state=s1")).toMatchObject({ code: "dxc_abc", state: "s1" })
		expect(parseCallbackInput("code=dxc_abc")).toMatchObject({ code: "dxc_abc" })
		expect(parseCallbackInput("  dxc_abc-123  ")).toEqual({ code: "dxc_abc-123" })
	})
	it("surfaces errors and rejects garbage", () => {
		expect(parseCallbackInput("http://127.0.0.1:1/callback?error=access_denied&error_description=nope")).toMatchObject({ code: "", error: "access_denied", errorDescription: "nope" })
		expect(parseCallbackInput("")).toBeNull()
		expect(parseCallbackInput("hello world")).toBeNull()
		expect(parseCallbackInput("http://x/?foo=bar")).toBeNull()
	})
})
