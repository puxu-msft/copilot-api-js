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
| `--auto-truncate` | disabled | Enable reactive auto-truncate on context-limit errors |
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

#### OpenAI compatible

Each route is registered with no prefix, with `/v1`, and with `/openai/v1`.

| Endpoint | Method |
|----------|--------|
| `/chat/completions` | POST |
| `/responses` | POST (also WS GET) |
| `/embeddings` | POST |
| `/models` | GET |
| `/models/:model` | GET |

#### Azure OpenAI compatible

| Endpoint | Method |
|----------|--------|
| `/openai/deployments/:deployment/chat/completions` | POST |
| `/openai/deployments/:deployment/embeddings` | POST |
| `/openai/deployments/:deployment/responses` | POST |

#### Anthropic compatible

| Endpoint | Method |
|----------|--------|
| `/v1/messages`, `/anthropic/v1/messages` | POST |
| `/v1/messages/count_tokens`, `/anthropic/v1/messages/count_tokens` | POST |
| `/anthropic/v1/models` | GET |
| `/anthropic/v1/models/:id` | GET |

`/v1/messages` requires an Anthropic-vendor model — it talks to Copilot's native Anthropic endpoint.

#### Google Gemini compatible

| Endpoint | Method |
|----------|--------|
| `/v1beta/models/:model:generateContent` | POST |
| `/v1beta/models/:model:streamGenerateContent` | POST (SSE) |
| `/v1beta/models/:model:countTokens` | POST |

---

## Config and Data Storage

The recommended defaults ship as **[`config.yaml`](config.yaml) at the package root** (bundled with the npm release). Your personal overrides live at `~/.local/share/copilot-api/config.yaml`. At runtime the effective configuration = **bundled defaults deep-merged with your overrides** (user wins per key):

See [`config.example.yaml`](config.example.yaml) for the full annotated reference (includes commented-out optional fields).

The GitHub token, learned negotiation state and the SQLite history database live alongside the user config under the data directory:

- Default: `~/.local/share/copilot-api/`
- Honors `XDG_DATA_HOME` if set: `$XDG_DATA_HOME/copilot-api/`

Most fields hot-reload at runtime (the file is watched). Hot-reload semantics are *retain-on-absence*: missing keys keep the previous value; explicit empty values (`disabled_models: []`, `model_overrides: {}`) clear the field.

### Data directory layout

```
~/.local/share/copilot-api/         # or $XDG_DATA_HOME/copilot-api/
├── config.yaml                     # user config (hot-reloaded)
├── github_token                    # GitHub device-flow token
├── history.db                      # SQLite history (gzip-compressed payloads)
├── negotiation-states.json         # learned per-model bans (betas / body fields / efforts)
```

---

## Internal API Endpoints

### Management & UI

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Server status (uptime, account type, model count, in-flight, etc.) |
| `/api/stats` | GET | Operational stats — per-dimension breakdown (`?dimension=model\|endpoint\|client\|agentKind\|tool&window=sinceStart\|7d&limit=N`) with token/cost counters + latency/queue/token percentiles |
| `/api/tokens` | GET | GitHub + Copilot token info (masked unless `--show-github-token`) |
| `/api/models` | GET | Internal model catalog (full Copilot data) |
| `/api/models/:model` | GET | Single model (internal full shape) |
| `/api/config` | GET | Effective runtime configuration |
| `/api/config/yaml` | GET / PUT | Read / replace `config.yaml` (triggers full re-apply) |
| `/api/negotiation` | GET / POST | Reactive-learning records (feature-negotiation cache) management. Backs the ui-v4 **Learned** page: view reactive learning records grouped by function, per-category TTL with auto-expiry, per-entry pin / renew / expire-now / delete, and full JSON export. `GET` grouped snapshot, `POST /renew`\|`/expire`\|`/pin`\|`/entry/delete`, `GET /export` full v2 JSON |
| `/api/logs` | GET | Recent request logs (in-memory ring buffer) |
| `/api/event_logging/batch` | POST | Silently consumes Anthropic event-logging beacons |
| `/metrics` | GET | Prometheus text exposition (v0.0.4) — `copilot_api_*_total{dimension,key}` counters + per-dimension histograms (duration/queue/token) |
| `/health` | GET | Readiness check — 200 when tokens/models are ready, 503 otherwise |
| `/health/liveness` | GET | Liveness probe — always 200 `{status:"alive"}` while the process responds (independent of upstream/readiness) |
| `/ui/*` | GET | Vuetify-based History Web UI (static SPA) |

### History API

REST under `/history/api/`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/history/api/entries` | GET | Paginated entry list (filter by model / endpoint / status / session / time) |
| `/history/api/entries/:id` | GET | Single entry (decoded payload + response, headers, timing, billing) |
| `/history/api/entries` | DELETE | Full clear of all history (destructive). Per-session delete is `DELETE /api/sessions/:id` |
| `/history/api/stats` | GET | Aggregate counts, token totals, billing multipliers, model breakdown |
| `/history/api/sessions` | GET | Session list (Claude Code / Codex sessions inferred from headers) |
| `/history/api/sessions/:id` | DELETE | Delete all entries for a session |
| `/history/api/export` | GET | Export history as JSON |

WebSocket `/ws` is a topic-aware bus carrying:

- `history` — new entries, updates, finalize, delete events
- `status` — server status changes
- `shutdown` — drain begin / phase transitions
- (per-request) live SSE replay for in-flight requests

---

## License

[MIT](LICENSE)
