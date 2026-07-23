# Copilot API Proxy \(Folk\)

> [!NOTE]
> This is a fork of [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) which works :\).

> [!WARNING]
> Reverse proxy for the GitHub Copilot API. It is not officially supported by GitHub and may break at any time. Use at your own risk.

A reverse proxy that exposes GitHub Copilot API from your GitHub Copilot subscription as OpenAI, Anthropic, AOAI and Google Gemini compatible endpoints, so you can drive Claude Code, Codex, Gemini and other AI agent tools through one local server.

---

## Quick Start

### Install from npm (Recommended)

```sh
npx -y @hsupu/copilot-api start

# beta version
npx -y @hsupu/copilot-api@beta start
```

First run will trigger GitHub device-flow auth automatically and cache the token under
`~/.local/share/copilot-api/` (override with `XDG_DATA_HOME`).

### Run from Source

```sh
git clone https://github.com/puxu-msft/copilot-api-js.git
cd copilot-api-js
bun install
bun run dev  # Development mode with hot reload (main server only, API-only — see "Hosting the Web UI" below)
bun run dev:ui  # Development mode for UI on Vite dev server

# Publish to npm
BROWSER=wslview npm login
BROWSER=wslview npm publish --access public --tag beta
BROWSER=wslview npm dist-tag add @hsupu/copilot-api@0.8.3 latest
```

## Commands

| Command | Description |
|---------|-------------|
| `start` | Start the API server (authenticates automatically if needed) |
| `login` (alias: `auth`) | Run GitHub device-flow authentication, store the GitHub token |
| `logout` | Clear the stored GitHub token |
| `debug usage` | Show Copilot subscription usage and quota |
| `debug info` | Print diagnostic info (paths, runtime, config summary) |
| `debug models` | Fetch and dump raw model metadata from Copilot |
| `list-claude-code` | List locally-installed Claude Code versions |
| `setup-claude-code` | Interactively configure Claude Code to use this proxy |

### `start` options

| Option | Default | Description |
|--------|---------|-------------|
| `--port`, `-p` | `4141` | Port to listen on |
| `--host`, `-H` | `localhost` | `localhost` (v4+v6 loopback), `any` (0.0.0.0+::), or a specific address |
| `--account-type`, `-a` | auto-detect | `individual` / `business` / `enterprise` (selects API base URL). When omitted, inferred from the logged-in account; falls back to `individual`. |
| `--ghc-api-base-url` |  | Explicit upstream GHC API base URL (e.g. `https://api.githubcopilot.com`). Overrides `--account-type` when set. |
| `--github-token`, `-g` |  | Provide a pre-issued GitHub token instead of running auth |
| `--show-github-token` | `false` | Print the GitHub token in logs |
| `--proxy` |  | Override outbound proxy URL (http/https/socks5/socks5h) |
| `--no-http-proxy-from-env` | enabled | Ignore `HTTP_PROXY` / `HTTPS_PROXY` env vars |
| `--no-rate-limit` | enabled | Disable the adaptive rate limiter |
| `--no-history` | enabled | No-history mode: don't open/create the History database or record anything (overrides config `history.enabled`) |

`--account-type` determines the upstream API base URL (unless `--ghc-api-base-url` overrides it):

| Type | API Base URL |
|------|--------------|
| `individual` | `api.githubcopilot.com` |
| `business` | `api.business.githubcopilot.com` |
| `enterprise` | `api.enterprise.githubcopilot.com` |

Experimental options:

| Option | Default | Description |
|--------|---------|-------------|
| `--verbose`, `-v` | `false` | Verbose logging (includes Copilot token refresh logs) |
| `--mock-rate-limiter-throttled` | `false` | Test-only: simulate upstream 429 after the limiter timeout |

---

## Usage

### Using with Claude Code

Run the interactive setup command:

```sh
npx -y @hsupu/copilot-api setup-claude-code
```

Or manually create and modify `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "haiku",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "sonnet",
    "ANTHROPIC_MODEL": "opus[1m]",
    "ANTHROPIC_SMALL_FAST_MODEL": "haiku",
    "CLAUDE_CODE_SUBAGENT_MODEL": "opus",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
    "DISABLE_TELEMETRY": "1"
  }
}
```

### Using with Codex CLI / OpenAI SDK

Point `OPENAI_BASE_URL` (or the equivalent) at the proxy:

```sh
export OPENAI_BASE_URL=http://localhost:4141/v1
export OPENAI_API_KEY=dummy
codex  # or any OpenAI SDK client
```

Or create and modify `~/.codex/config.toml` (honors `$CODEX_HOME`):

```toml
model_provider = "ghc"

[model_providers.ghc]
name = "ghc"
base_url = "http://localhost:4141/v1"
wire_api = "responses"
preferred_auth_method = "apikey"
```

Or let the proxy write this managed block for you:

```sh
npx copilot-api setup-codex
```

### Using with Gemini CLI

```bash
export GOOGLE_GEMINI_BASE_URL=http://localhost:4141/v1beta
export GEMINI_API_KEY=dummy  # not validated, but the CLI requires the var
gemini -p "hello"
```

### Using API Endpoints

The proxy exposes OpenAI, Azure OpenAI, Anthropic, and Google Gemini compatible endpoints (each vendor family under its conventional prefixes — e.g. OpenAI routes are registered with no prefix, `/v1`, and `/openai/v1`), plus management, History, and health APIs.

**See [`docs/API.md`](docs/API.md) for the complete endpoint reference** (all routes, prefix variants, and field-level notes). The live source of truth for a running instance is `GET /openapi.json` (with an interactive Scalar page at `/docs`).

Any client SDK can drive any GHC model via an `@cc` / `@responses` / `@messages` model-name suffix (the universal translation matrix) — e.g. an OpenAI client can call `claude-opus-4.8@messages`. Details in [`docs/API.md`](docs/API.md#调用基础).

Streaming requests use an explicit upstream generation runtime. By default, if the primary physical request has produced no complete real client-protocol block after 300 seconds, one secondary candidate starts while the primary continues; the first complete block wins and the loser is cancelled and fully quiesced. Synthetic keepalive scaffolding does not count as model progress. Requests declaring server-executed tools are excluded unless explicitly opted in. Configure this under `generation.*`; downstream heartbeat, upstream retry/competition, and transport connection keepalive are independent mechanisms.

---

## Config and Data Storage

The recommended defaults ship as **[`config.yaml`](config.yaml) at the package root** (bundled with the npm release). Your personal overrides live at `~/.local/share/copilot-api/config.yaml`. At runtime the effective configuration = **bundled defaults deep-merged with your overrides** (user wins per key):

See [`config.example.yaml`](config.example.yaml) for the full annotated reference (includes commented-out optional fields).

The GitHub token, learned negotiation state and the SQLite history database live alongside the user config under the data directory:

- Default: `~/.local/share/copilot-api/`
- Honors `XDG_DATA_HOME` if set: `$XDG_DATA_HOME/copilot-api/`

Most fields hot-reload at runtime (the file is watched). Hot-reload semantics are *retain-on-absence*: missing keys keep the previous value; explicit empty values (`disabled_models: []`, `model_overrides: {}`) clear the field.

`generation.hedge.*` controls live fast-retry (`enabled`, `threshold_sec`, `max_secondary_candidates`, `allow_server_tools`); the sibling generation fields bound active/total candidates and dispatches. Values are snapshotted when a request starts, so a hot reload affects new generations only.

### Data directory layout

```
~/.local/share/copilot-api/         # or $XDG_DATA_HOME/copilot-api/
├── config.yaml                     # user config (hot-reloaded)
├── github_token                    # GitHub device-flow token
├── history-v3.db                   # Canonical semantic CAS + journal (search is a separate sidecar, see below)
├── history-search/                 # Full-text search index (Tantivy) — only populated if the sidecar service is running
├── history-search.sock             # Unix domain socket the search sidecar listens on, if running
├── raw.db                          # Optional exact-byte CAS (disabled by default)
├── negotiation-states.json         # learned per-model bans (betas / body fields / efforts)
```

### Optional: full-text History search sidecar

Full-text History search runs as an **independent, optional service** — `history-search-daemon`, a separate long-lived process the main server never spawns or supervises (a native full-text-index crash can then never take down the main server). Without it running, `GET /history/api/search` simply returns empty results.

```bash
# Start it directly (defaults already point at the same on-disk db/socket paths
# the main server uses — no flags needed):
copilot-api history-search-daemon
```

For a persistent, auto-restarting deployment, see the systemd unit templates and notes in **[`contrib/systemd/`](contrib/systemd/)** (main-server blue-green units + the optional history-search sidecar unit).

---

## Internal API Endpoints

Management (`/api/*`), History REST (`/history/api/*`), metrics (`/metrics`), health probes (`/health`, `/health/readiness`, `/health/liveness`), and the History WebSocket (`/ws`) are all documented in **[`docs/API.md`](docs/API.md)** alongside the vendor-compatible endpoints. The main server is API-only — it does not serve, proxy, or build any Web UI; see "Hosting the Web UI" below.

History is persisted to a content-addressed SQLite store (`history-v3.db`): every request/response is recorded as an immutable canonical operation record via a single-writer terminal bus, with periodic DB maintenance (WAL checkpoint / incremental vacuum / analyze). There is no built-in tiered cold-format archiving — the `history.archive.*` config surface was retired together with History V2 (2026-07-18). See **[`docs/history.md`](docs/history.md)** and **[`docs/lifecycle.md`](docs/lifecycle.md)**.

---

## Hosting the Web UI

The main server is API-only: it never serves, proxies, or builds `ui/` (legacy Vue) or `ui-v4/` (React, the actively developed History UI). Both workspaces are kept in this repo and are meant to be built and hosted **independently** by ops, with a reverse proxy in front routing API traffic to the backend (default `localhost:4141`):

```sh
# Build the UI you want to serve (ui-v4 is the actively developed one)
bun run build:ui-v4   # → ui-v4/dist
# bun run build:ui    # → ui/dist (legacy Vue, being retired — see docs/vue-ui-retirement.md)

# Serve ui-v4/dist with any static file server, e.g.:
npx serve ui-v4/dist
```

Then put a reverse proxy in front that forwards these paths to the backend (`localhost:4141` by default):

| Path | Protocol | Notes |
|------|----------|-------|
| `/api/*` | HTTP | Management API |
| `/history/api/*` | HTTP | History REST |
| `/ws` | WebSocket | History/live-request push |
| `/models` | HTTP | OpenAI-compatible model list (consumed by the UI) |

Everything else (the UI's own static assets, index.html, client-side routes) is served by the static file server, not the backend.

**Base path caveat**: `ui-v4/vite.config.ts` bakes in `base: "/ui-v4/"` for production builds, and the legacy `ui/vite.config.ts` bakes in `base: "/ui/"`. If you host either workspace at a different path prefix (or at the domain root), adjust that workspace's `base` before building, or configure your reverse proxy to strip/rewrite the prefix accordingly.

---

## License

[MIT](LICENSE)
