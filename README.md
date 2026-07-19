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
bun run dev --external-ui-url http://localhost:5173  # Development mode with hot reload and proxying /ui to the Vite dev server
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
| `--external-ui-url` |  | Reverse-proxy `/ui` to an external Vite dev / build server |
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
├── history-v3.db                   # Canonical semantic CAS + journal + search
├── raw.db                          # Optional exact-byte CAS (disabled by default)
├── negotiation-states.json         # learned per-model bans (betas / body fields / efforts)
```

---

## Internal API Endpoints

Management (`/api/*`), History REST (`/history/api/*`), metrics (`/metrics`), health probes (`/health`, `/health/readiness`, `/health/liveness`), the History WebSocket (`/ws`), and the Web UIs (`/ui/*`, `/ui-v4/*`) are all documented in **[`docs/API.md`](docs/API.md)** alongside the vendor-compatible endpoints.

History archiving is configured under `history.archive.*`. When enabled, old entries cool from HOT `history.db` into `archive.db` and immutable session-generation seal units instead of being hard-deleted. Shutdown seals archive workers after their current durable unit; remaining backlog resumes on the next start. See **[`docs/history.md`](docs/history.md)** and **[`docs/lifecycle.md`](docs/lifecycle.md)**.

---

## License

[MIT](LICENSE)
