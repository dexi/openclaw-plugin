# Dexi for OpenClaw

Your [Dexi](https://dexi.net) notes library — clipped web pages, emailed articles, RSS entries, and typed notes — as [OpenClaw](https://openclaw.ai)'s long-term memory.

Two ways to use it, pick one:

| | Native MCP server (`openclaw mcp add dexi …`) | **Memory plugin (this package)** |
|---|---|---|
| Tools | all 12 Dexi tools as `dexi__*` | compact `dexi_*` set (search / get / list / save / append / tags / folders / reviews) |
| Auto-recall before each turn (`<dexi-context>`) | — | ✅ |
| Memory prompt section | — | ✅ |
| `/remember` · `/recall` commands | — | ✅ |
| Session digest note (opt-in) | — | ✅ |
| Skills (`dexi-capture` / `dexi-recall` / `dexi-review`) | — | ✅ |
| Works alongside OpenClaw's built-in memory (`memory-core`) | ✅ | ✗ — takes the exclusive **memory slot**, so local `memory_search`/`memory_get`, dreaming and the markdown memory flush are off while Dexi is the memory plugin |
| Auth | OAuth (`openclaw mcp login dexi`) | OAuth (`openclaw dexi login`), browser or paste-back |

The MCP-server route needs no install: `openclaw mcp add dexi --url https://mcp.dexi.net/mcp --transport streamable-http --auth oauth` then `openclaw mcp login dexi` — see [dexi.net/mcp/openclaw](https://dexi.net/mcp/openclaw). Read on for the plugin.

## Install

```bash
openclaw plugins install openclaw-dexi
openclaw plugins enable openclaw-dexi    # claims the memory slot (unlocks the `openclaw dexi` CLI)
openclaw dexi setup                      # hook permissions + tool allowlist, then signs you in
openclaw gateway restart
```

`setup` writes `plugins.entries.openclaw-dexi` (with the hook permissions the memory hooks need), `plugins.slots.memory = "openclaw-dexi"`, and the tool allowlist into `~/.openclaw/openclaw.json`, then runs `openclaw dexi login`. Flags: `--read-only`, `--session-digest`, `--digest-tag <tag>`, `--mcp-url <url>`, `--no-login`, `--no-browser`.

Requires OpenClaw ≥ 2026.5.7 (Node 22+).

### Headless / VPS

`openclaw dexi login` prints the authorize URL and starts a loopback listener on 127.0.0.1. On a laptop the browser callback completes it. On a server, open the URL anywhere, sign in to Dexi, approve (you can restrict the connection to one folder or tag on that page), and paste the final redirect URL — or just its `?code=…&state=…` part — back into the terminal (or run `openclaw dexi login --code '<pasted value>'`). Tokens are stored in `~/.openclaw/dexi/oauth.json` (mode 0600); the gateway reuses them silently after a restart.

## What it does

- **Auto-recall** — before each interactive turn, semantic search over your notes for the incoming message (plus a keyword pass when it contains a `#hashtag` or a "quoted phrase"); hits above the similarity floor are injected as a `<dexi-context>` block of titles + snippets. Never full bodies — the model calls `dexi_get`/`full_text` when it wants one. Best-effort, ~2.5 s budget, failures inject nothing.
- **Tools** — `dexi_search` (hybrid keyword+semantic, `full_text` option), `dexi_get`, `dexi_list` (source/tag/folder/period/`since`), `dexi_save`, `dexi_append`, `dexi_tags`, `dexi_folders`, `dexi_reviews_due`, `dexi_review_grade`. Each forwards to Dexi's MCP tool of the same purpose; each accepts an optional `intent` sentence for Dexi's aggregate tool analytics.
- **Commands** — `/remember <text>` saves a note (first line = title, `#hashtags` become tags), `/recall <query>` searches, `/dexi-digest` writes this session's digest now.
- **Session digest** (off by default) — one note per conversation, written when the session ends (`/new`, `/reset`, idle/daily rotation), before compaction, after `digestIdleMinutes` of quiet, or at shutdown — never per turn: the questions asked, the last answer, and the session key, tagged `#openclaw`. Later flushes append to the same note (the session→note mapping is persisted in `~/.openclaw/dexi/digests.json`, so gateway restarts and one-shot `openclaw agent` runs don't create duplicates). Deterministic; no LLM call in the plugin.
- **Skills** — `dexi-capture`, `dexi-recall`, `dexi-review` (spaced-repetition quiz over your due cards) load while the plugin is enabled.
- **Not done, on purpose** — no note per turn, no mirroring of transcripts or `MEMORY.md`, no LLM-written summaries. Dexi is your notes app; the agent is a reader and an occasional, deliberate writer.

## What leaves your device

Only when the corresponding feature runs:

| Feature | Data sent to `mcp.dexi.net` |
|---|---|
| Auto-recall (`autoRecall`, default on) | the current user message (≤500 chars, channel metadata stripped) as a search query |
| Tools / commands | the arguments the model (or you) pass — query text, note text you asked it to save |
| Session digest (`sessionDigest`, default **off**) | your session's user messages (first ~240 chars each, up to 12) + the last answer (~1,200 chars) |

Nothing else — no full transcripts, no tool-call history, no local memory files. Everything lands in your Dexi account, visible in the app, deletable there. Set `readOnly: true` to make the connection incapable of writing at all (the plugin requests only the `notes:read` scope; save/append/grade tools, `/remember`, and the digest disappear).

## Configuration

`plugins.entries.openclaw-dexi.config` in `~/.openclaw/openclaw.json` (every key optional; `DEXI_<KEY>` env vars override, e.g. `DEXI_MCP_URL`):

| Key | Default | Meaning |
|---|---|---|
| `autoRecall` | `true` | inject relevant notes before each turn |
| `recallResults` | `5` | max notes injected (1–20) |
| `recallMinSimilarity` | `0.55` | semantic similarity floor (0–1) |
| `sessionDigest` | `false` | write one digest note per session |
| `digestTag` | `#openclaw` | tag on digest notes (`\w` chars only — Dexi's hashtag syntax) |
| `digestIdleMinutes` | `30` | also flush after this much quiet |
| `readOnly` | `false` | request `notes:read` only; hide write tools |
| `recallTimeoutMs` | `2500` | recall is skipped past this |
| `toolTimeoutMs` | `30000` | per explicit tool call |
| `mcpUrl` | `https://mcp.dexi.net/mcp` | override for self-hosted/dev |
| `debug` | `false` | verbose plugin logs |

CLI: `openclaw dexi setup | login [--read-only] [--no-browser] [--code <value>] | logout | status | search <query> | save <text>`.

Manage or revoke the grant itself in Dexi → **Settings → Connected apps** — you can also narrow it to one folder/tag there; the change applies on the next request.

## Development

```bash
npm ci
npm run check-types && npm test          # vitest against a fake Dexi client (no network)
npm run build                            # esbuild → dist/index.js (required before a local-path install)
openclaw plugins install --link "$PWD"   # source checkout into your OpenClaw
DEXI_MCP_URL=http://localhost:8001/mcp openclaw dexi login   # against a local Dexi backend
npm pack && openclaw plugins install npm-pack:./openclaw-dexi-*.tgz --force   # packaging proof
```

Layout: `index.ts` (plugin entry), `src/client.ts` (MCP client + typed helpers), `src/auth/` (OAuth provider, token store, login/logout), `src/recall.ts`, `src/capture.ts` + `src/digest.ts`, `src/tools.ts`, `src/commands.ts`, `src/cli.ts`, `src/runtime.ts` (memory-slot search manager), `src/prompt.ts`, `skills/`, `tests/`.

Source of truth is `openclaw-plugin/` in the private `dexi/dexi` monorepo; this repository is a mirror. Tool docs: [docs.dexi.net/mcp/tools](https://docs.dexi.net/mcp/tools). MIT licensed.
