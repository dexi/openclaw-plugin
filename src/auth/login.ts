/**
 * `openclaw dexi login` — Dexi's OAuth 2.1 flow (dynamic client registration
 * + PKCE) driven through the MCP SDK's `auth()` helper.
 *
 * Desktop: a loopback listener on 127.0.0.1 receives the redirect. Headless
 * (VPS, container): the user opens the printed URL anywhere, approves, and
 * pastes the final redirect URL (or just its `code=…&state=…` part, or the
 * bare code) back into the terminal — whichever arrives first wins.
 *
 * `auth()` is used directly (rather than the transport's finishAuth) so the
 * requested scope is under our control: Dexi's protected-resource metadata
 * advertises both scopes, and the SDK prefers that over clientMetadata.scope,
 * which would defeat `readOnly`.
 */
import { spawn } from "node:child_process"
import http from "node:http"
import type { AddressInfo } from "node:net"
import readline from "node:readline"
import { auth } from "@modelcontextprotocol/sdk/client/auth.js"
import { DexiClient, dexi } from "../client.js"
import { DEFAULT_LOOPBACK_PORT, DexiAuthError, FileOAuthClientProvider, scopeFor } from "./provider.js"
import type { OAuthStore } from "./store.js"

export type LoginIO = {
	print: (line: string) => void
	/** Ask a question on stdin; resolves with the raw answer. Undefined = non-interactive. */
	question?: (prompt: string) => Promise<string>
}

export type LoginOptions = {
	store: OAuthStore
	mcpUrl: string
	readOnly: boolean
	io: LoginIO
	/** Open the authorize URL in a browser (default: yes when it looks like a desktop). */
	openBrowser?: boolean
	/** Skip the URL step: complete a pending login with this pasted value. */
	code?: string
	/** Overall wait for the callback/paste (ms). Dexi's authorize request itself expires after 10 minutes. */
	timeoutMs?: number
	clientVersion?: string
}

export type ParsedCallback = { code: string; state?: string; error?: string; errorDescription?: string }

/** Accepts a full redirect URL, a bare query string, or a bare code. */
export function parseCallbackInput(raw: string): ParsedCallback | null {
	const s = raw.trim()
	if (!s) return null
	let params: URLSearchParams | undefined
	if (/^https?:\/\//i.test(s)) {
		try {
			params = new URL(s).searchParams
		} catch {
			return null
		}
	} else if (s.includes("=")) {
		params = new URLSearchParams(s.replace(/^[?#]/, ""))
	}
	if (params) {
		const error = params.get("error") ?? undefined
		const code = params.get("code") ?? ""
		if (!code && !error) return null
		return {
			code,
			state: params.get("state") ?? undefined,
			error,
			errorDescription: params.get("error_description") ?? undefined,
		}
	}
	if (/^[A-Za-z0-9._~\-]+$/.test(s)) return { code: s }
	return null
}

function looksHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.SSH_CONNECTION || env.SSH_TTY) return true
	if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true
	if (env.CI) return true
	return false
}

export function tryOpenBrowser(url: string): boolean {
	try {
		const [cmd, args] =
			process.platform === "darwin"
				? ["open", [url]]
				: process.platform === "win32"
					? ["cmd", ["/c", "start", "", url]]
					: ["xdg-open", [url]]
		const child = spawn(cmd, args, { stdio: "ignore", detached: true })
		child.on("error", () => {})
		child.unref()
		return true
	} catch {
		return false
	}
}

const CALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>Dexi connected</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">
<h1 style="font-size:1.4rem">Dexi is connected to OpenClaw</h1>
<p>You can close this tab and return to the terminal.</p></body>`

const CALLBACK_ERR_HTML = `<!doctype html><meta charset="utf-8"><title>Dexi login failed</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5">
<h1 style="font-size:1.4rem">Login didn't complete</h1><p>Return to the terminal and run <code>openclaw dexi login</code> again.</p></body>`

type Listener = { redirectUrl: string; result: Promise<ParsedCallback>; close: () => void }

async function startListener(): Promise<Listener> {
	let resolveCb: (p: ParsedCallback) => void = () => {}
	const result = new Promise<ParsedCallback>((r) => {
		resolveCb = r
	})
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		if (url.pathname !== "/callback") {
			res.statusCode = 404
			res.end("not found")
			return
		}
		const parsed = parseCallbackInput(url.search)
		res.setHeader("content-type", "text/html; charset=utf-8")
		if (!parsed) {
			res.statusCode = 400
			res.end(CALLBACK_ERR_HTML)
			return
		}
		res.end(parsed.error ? CALLBACK_ERR_HTML : CALLBACK_HTML)
		resolveCb(parsed)
	})
	// Keep the process alive while we wait for the callback (non-TTY runs
	// have nothing else on the event loop).
	const listen = (port: number) =>
		new Promise<boolean>((resolve) => {
			server.once("error", () => resolve(false))
			server.listen(port, "127.0.0.1", () => resolve(true))
		})
	// Prefer the fixed port so a stored DCR record (registered against this
	// redirect URI) can be reused; fall back to a random port.
	if (!(await listen(DEFAULT_LOOPBACK_PORT))) {
		server.removeAllListeners("error")
		if (!(await listen(0))) throw new Error("could not bind a loopback port for the OAuth callback")
	}
	const { port } = server.address() as AddressInfo
	return {
		redirectUrl: `http://127.0.0.1:${port}/callback`,
		result,
		close: () => server.close(),
	}
}

export async function login(opts: LoginOptions): Promise<{ scope: string; probe: string }> {
	const { store, mcpUrl, io } = opts
	const scope = scopeFor(opts.readOnly)
	const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000

	// --code: finish a login started earlier (same redirect URI, verifier on disk).
	if (opts.code) {
		const pending = store.get(mcpUrl)
		const redirectUrl = pending.pendingRedirectUrl
		if (!redirectUrl || !pending.codeVerifier) {
			throw new DexiAuthError("No pending Dexi login to complete — run `openclaw dexi login` first.")
		}
		const parsed = parseCallbackInput(opts.code)
		if (!parsed || !parsed.code) throw new Error("Could not find an authorization code in the pasted value.")
		const provider = new FileOAuthClientProvider(store, mcpUrl, { kind: "login", redirectUrl, onAuthorizeUrl: () => {} }, scope)
		await auth(provider, { serverUrl: mcpUrl, authorizationCode: parsed.code, scope })
		store.clear(mcpUrl, ["codeVerifier", "pendingRedirectUrl"])
		const probe = await probeConnection(store, mcpUrl, opts.readOnly, opts.clientVersion)
		return { scope, probe }
	}

	// Fresh consent every time: clear tokens (keep client registration + discovery).
	store.clear(mcpUrl, ["tokens"])

	const listener = await startListener()
	let authorizeUrl: URL | undefined
	const provider = new FileOAuthClientProvider(
		store,
		mcpUrl,
		{ kind: "login", redirectUrl: listener.redirectUrl, onAuthorizeUrl: (u) => (authorizeUrl = u) },
		scope,
	)
	try {
		const first = await auth(provider, { serverUrl: mcpUrl, scope })
		if (first === "AUTHORIZED" || !authorizeUrl) {
			// Can't happen after clearing tokens, but keep the contract honest.
			listener.close()
			const probe = await probeConnection(store, mcpUrl, opts.readOnly, opts.clientVersion)
			return { scope, probe }
		}
		store.update(mcpUrl, { pendingRedirectUrl: listener.redirectUrl })

		const url = authorizeUrl.toString()
		const headless = looksHeadless()
		const shouldOpen = opts.openBrowser ?? !headless
		io.print("")
		io.print("Open this URL to connect Dexi (sign in, then approve — you can restrict the")
		io.print("connection to one folder or tag on that page):")
		io.print("")
		io.print(`  ${url}`)
		io.print("")
		if (shouldOpen && tryOpenBrowser(url)) io.print("(opened in your browser)")
		io.print(
			"Headless or remote machine? Open the URL anywhere, approve, then paste the final",
		)
		io.print("redirect URL (or just its ?code=…&state=… part) here. The link expires in 10 minutes.")
		io.print("")

		const parsed = await waitForCallback(listener, io, timeoutMs)
		if (parsed.error) {
			throw new Error(`Dexi login was denied (${parsed.error}${parsed.errorDescription ? `: ${parsed.errorDescription}` : ""}).`)
		}
		const expected = provider.expectedState
		if (parsed.state && expected && parsed.state !== expected) {
			throw new Error("The pasted callback belongs to a different login attempt (state mismatch). Run login again.")
		}
		const done = await auth(provider, { serverUrl: mcpUrl, authorizationCode: parsed.code, scope })
		if (done !== "AUTHORIZED") throw new Error("Token exchange did not complete.")
		store.clear(mcpUrl, ["codeVerifier", "pendingRedirectUrl"])
	} finally {
		listener.close()
	}
	const probe = await probeConnection(store, mcpUrl, opts.readOnly, opts.clientVersion)
	return { scope, probe }
}

async function waitForCallback(listener: Listener, io: LoginIO, timeoutMs: number): Promise<ParsedCallback> {
	const timers: NodeJS.Timeout[] = []
	const timeout = new Promise<never>((_, reject) => {
		const t = setTimeout(() => reject(new Error("Timed out waiting for the Dexi authorization callback.")), timeoutMs)
		t.unref()
		timers.push(t)
	})
	const racers: Promise<ParsedCallback>[] = [listener.result]
	let rl: readline.Interface | undefined
	if (io.question) {
		racers.push(pasteLoop(io))
	} else if (process.stdin.isTTY) {
		rl = readline.createInterface({ input: process.stdin, output: process.stdout })
		const ask = (q: string) => new Promise<string>((resolve) => rl?.question(q, resolve))
		racers.push(pasteLoop({ ...io, question: ask }))
	}
	try {
		return await Promise.race([...racers, timeout])
	} finally {
		for (const t of timers) clearTimeout(t)
		rl?.close()
	}
}

async function pasteLoop(io: LoginIO): Promise<ParsedCallback> {
	// Loop until something parseable arrives; the race is settled by whichever
	// source (browser callback or paste) produces a callback first.
	for (;;) {
		const answer = await io.question!("Paste the redirect URL or code (or wait for the browser callback): ")
		const parsed = parseCallbackInput(answer)
		if (parsed) return parsed
		if (answer.trim()) io.print("That doesn't look like a redirect URL or code — try again.")
	}
}

async function probeConnection(store: OAuthStore, mcpUrl: string, readOnly: boolean, clientVersion?: string): Promise<string> {
	const client = new DexiClient({ mcpUrl, store, readOnly, toolTimeoutMs: 20_000, clientVersion })
	try {
		const f = await dexi.listFolders(client, { intent: "verify connection after login" })
		const n = f.folders.length
		return `${n} folder${n === 1 ? "" : "s"}${f.unfiled_count !== undefined ? `, ${f.unfiled_count} unfiled notes` : ""}`
	} finally {
		await client.close()
	}
}

/** Best-effort token revocation, then forget everything for this server. */
export async function logout(store: OAuthStore, mcpUrl: string): Promise<{ revoked: boolean }> {
	const entry = store.get(mcpUrl)
	let revoked = false
	const token = entry.tokens?.refresh_token ?? entry.tokens?.access_token
	if (token && entry.client?.client_id) {
		const disc = entry.discovery as { authorizationServerMetadata?: { revocation_endpoint?: string; issuer?: string } } | undefined
		const endpoint =
			disc?.authorizationServerMetadata?.revocation_endpoint ??
			(disc?.authorizationServerMetadata?.issuer ? `${disc.authorizationServerMetadata.issuer.replace(/\/$/, "")}/revoke` : undefined)
		if (endpoint) {
			try {
				const body = new URLSearchParams({
					token,
					token_type_hint: entry.tokens?.refresh_token ? "refresh_token" : "access_token",
					client_id: entry.client.client_id,
					// Dexi's revocation handler (MCP Python SDK) requires the field to be
					// present even for public clients; an empty secret is accepted.
					client_secret: entry.client.client_secret ?? "",
				})
				const res = await fetch(endpoint, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body,
					signal: AbortSignal.timeout(10_000),
				})
				revoked = res.ok
			} catch {
				revoked = false
			}
		}
	}
	store.clear(mcpUrl)
	return { revoked }
}
