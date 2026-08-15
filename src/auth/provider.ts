/**
 * `OAuthClientProvider` for the MCP TypeScript SDK, backed by OAuthStore.
 *
 * Two modes:
 * - `login`  — used by `openclaw dexi login`: has a real loopback redirect
 *   URL, hands the authorize URL to the CLI (`onAuthorizeUrl`), and forces
 *   re-registration when the stored client was registered with a different
 *   redirect URI (Dexi validates redirect_uri against the DCR record).
 * - `gateway` — used inside the OpenClaw gateway and by non-interactive CLI
 *   commands: refreshes silently, and if the SDK ever wants to redirect a
 *   browser it throws `DexiAuthError` instead (the gateway must never open a
 *   browser; the user runs `openclaw dexi login`).
 */
import { randomBytes } from "node:crypto"
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import type { OAuthStore, StoredClient, StoredTokens } from "./store.js"

export const CLIENT_NAME = "OpenClaw (Dexi memory)"
export const DEFAULT_LOOPBACK_PORT = 46161
export const LOGIN_HINT = "run `openclaw dexi login`"

export class DexiAuthError extends Error {
	constructor(message = `Dexi is not connected — ${LOGIN_HINT}.`) {
		super(message)
		this.name = "DexiAuthError"
	}
}

export function scopeFor(readOnly: boolean): string {
	return readOnly ? "notes:read" : "notes:read notes:write"
}

export type ProviderMode =
	| { kind: "gateway" }
	| { kind: "login"; redirectUrl: string; onAuthorizeUrl: (url: URL) => void }

export class FileOAuthClientProvider implements OAuthClientProvider {
	private _state?: string

	constructor(
		private readonly store: OAuthStore,
		private readonly serverUrl: string,
		private readonly mode: ProviderMode,
		private readonly scope: string,
	) {}

	get redirectUrl(): string {
		if (this.mode.kind === "login") return this.mode.redirectUrl
		// The SDK treats an undefined redirectUrl as a client_credentials flow;
		// declare the URI the stored client registered (or the default loopback)
		// so a stale-token path ends in redirectToAuthorization → DexiAuthError.
		const stored = this.store.get(this.serverUrl).client?.redirect_uris?.[0]
		return stored ?? `http://127.0.0.1:${DEFAULT_LOOPBACK_PORT}/callback`
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			redirect_uris: [this.redirectUrl],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			client_name: CLIENT_NAME,
			client_uri: "https://dexi.net",
			scope: this.scope,
		}
	}

	state(): string {
		if (!this._state) this._state = randomBytes(16).toString("hex")
		return this._state
	}

	/** The `state` value issued for the current login, for callback validation. */
	get expectedState(): string | undefined {
		return this._state
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		const client = this.store.get(this.serverUrl).client
		if (!client) return undefined
		if (this.mode.kind === "login") {
			const uris = client.redirect_uris ?? []
			if (!uris.includes(this.mode.redirectUrl)) return undefined
		}
		return client as OAuthClientInformationMixed
	}

	saveClientInformation(info: OAuthClientInformationMixed): void {
		this.store.update(this.serverUrl, { client: info as StoredClient })
	}

	tokens(): OAuthTokens | undefined {
		// Always from disk: another process (CLI ↔ gateway) may have refreshed.
		const t = this.store.get(this.serverUrl).tokens
		return t ? (t as OAuthTokens) : undefined
	}

	saveTokens(tokens: OAuthTokens): void {
		this.store.update(this.serverUrl, { tokens: tokens as StoredTokens, scope: tokens.scope ?? this.scope })
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		if (this.mode.kind === "login") {
			this.mode.onAuthorizeUrl(authorizationUrl)
			return
		}
		throw new DexiAuthError()
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.store.update(this.serverUrl, { codeVerifier })
	}

	codeVerifier(): string {
		const v = this.store.get(this.serverUrl).codeVerifier
		if (!v) throw new DexiAuthError(`No pending Dexi login — ${LOGIN_HINT}.`)
		return v
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		switch (scope) {
			case "all":
				this.store.clear(this.serverUrl)
				break
			case "client":
				this.store.clear(this.serverUrl, ["client"])
				break
			case "tokens":
				this.store.clear(this.serverUrl, ["tokens"])
				break
			case "verifier":
				this.store.clear(this.serverUrl, ["codeVerifier"])
				break
			case "discovery":
				this.store.clear(this.serverUrl, ["discovery"])
				break
		}
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		this.store.update(this.serverUrl, { discovery: state as unknown as Record<string, unknown> })
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		const d = this.store.get(this.serverUrl).discovery
		return d ? (d as unknown as OAuthDiscoveryState) : undefined
	}
}
