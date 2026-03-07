# Copilot API Proxy (Fork)

> [!NOTE]
> This is a fork of [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) with additional improvements and bug fixes.

> [!WARNING]
> This is a reverse proxy for the GitHub Copilot API. It is not officially supported by GitHub and may break at any time. Use at your own risk.

A reverse proxy that exposes GitHub Copilot's API as standard OpenAI and Anthropic compatible endpoints. Works with Claude Code, Cursor, and other tools that speak these protocols.

## Quick Start

### Install from npm (Recommended)

```sh
npx -y @hsupu/copilot-api start
```

### Run from Source

```sh
git clone https://github.com/puxu-msft/copilot-api-js.git
cd copilot-api-js
bun install
bun run dev      # Development mode with hot reload
bun run start    # Production mode
bun run build    # Build for distribution

# Testing
bun test                   # Backend unit tests
bun run test:all           # All backend tests
bun run test:ui            # Frontend (History UI) tests
bun run typecheck          # TypeScript type checking
```

## Using with Claude Code

Run the interactive setup command:

```sh
copilot-api setup-claude-code
```

Or manually create `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "opus",
    "ANTHROPIC_SMALL_FAST_MODEL": "haiku",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

## Features

### Dual API Compatibility

Exposes both OpenAI and Anthropic compatible endpoints through a single proxy:

- **Direct Anthropic path** — Uses Copilot API's native Anthropic endpoint for Claude models
- **OpenAI-compatible path** — Forwards OpenAI Chat Completions, Responses, Embeddings, and Models requests to Copilot's OpenAI endpoints

### Auto-Truncate

Automatically handles context length limits (enabled by default):

- **Reactive** — Retries failed requests with a truncated payload when hitting token or byte limits
- **Proactive** — Pre-checks requests against known model limits before sending
- **Dynamic limit learning** — Adjusts limits based on actual API error responses
- **Tool result compression** — Compresses old `tool_result` content before truncating messages

### Message Sanitization

Cleans up messages before forwarding to the API:

- Filters orphaned `tool_use` / `tool_result` blocks (unpaired due to interrupted tool calls or truncation)
- Fixes tool name casing mismatches
- Removes empty text content blocks
- Strips `<system-reminder>` tags from message content
- **[Optional]** Deduplicates repeated tool calls (`config.yaml: anthropic.dedup_tool_calls`)
- **[Optional]** Strips system-reminder tags from Read tool results (`config.yaml: anthropic.truncate_read_tool_result`)

### Model Name Translation

Translates client-sent model names to matching Copilot models:

| Input | Resolved To |
|-------|-------------|
| `opus`, `sonnet`, `haiku` | Best available model in that family |
| `claude-opus-4-6` | `claude-opus-4.6` |
| `claude-sonnet-4-6-20250514` | `claude-sonnet-4.6` |
| `claude-opus-4-6-fast`, `opus[1m]` | `claude-opus-4.6-fast`, `claude-opus-4.6-1m` |
| `claude-sonnet-4`, `gpt-4` | Passed through directly |

User-configured `model_overrides` (via config.yaml) can redirect any model name to another, with chained resolution and family-level overrides.

### Server-Side Tools

Supports Anthropic server-side tools (`web_search`, `tool_search`). These tools are executed by the API backend, with both `server_tool_use` and result blocks appearing inline in assistant messages. Tool definitions can optionally be rewritten to a custom format (`--no-rewrite-anthropic-tools`).

### Request History UI

Built-in web interface for inspecting API requests and responses. Access at `http://localhost:4141/history/v3/`.

- Real-time updates via WebSocket
- Filter by model, endpoint, status, and time range
- Session tracking and statistics

### Additional Features

- **Model overrides** — Configure arbitrary model name redirections via config.yaml
- **Adaptive rate limiting** — Intelligent rate limiting with exponential backoff (3 modes: Normal, Rate-limited, Recovering)
- **Tool name truncation** — Truncates tool names exceeding 64 characters (OpenAI limit) with hash suffixes
- **Health checks** — Container-ready endpoint at `/health`
- **Graceful shutdown** — Connection draining on shutdown signals
- **Proxy support** — HTTP/HTTPS proxy via environment variables

## Commands

| Command | Description |
|---------|-------------|
| `start` | Start the API server (authenticates automatically if needed) |
| `auth` | Run GitHub authentication flow only |
| `logout` | Remove stored GitHub token |
| `check-usage` | Show Copilot usage and quota information |
| `debug info` | Display diagnostic information |
| `debug models` | Fetch and display raw model data from Copilot API |
| `list-claude-code` | List all locally installed Claude Code versions |
| `setup-claude-code` | Interactively configure Claude Code to use this proxy |

### `start` Options

**General:**

| Option | Default | Description |
|--------|---------|-------------|
| `--port`, `-p` | 4141 | Port to listen on |
| `--host`, `-H` | (all interfaces) | Host/interface to bind to |
| `--verbose`, `-v` | false | Enable verbose logging |
| `--account-type`, `-a` | individual | Account type: `individual`, `business`, or `enterprise` |
| `--github-token`, `-g` | | Provide GitHub token directly |
| `--no-http-proxy-from-env` | enabled | Disable HTTP proxy from environment variables |

**Auto-Truncate:**

| Option | Default | Description |
|--------|---------|-------------|
| `--no-auto-truncate` | enabled | Disable auto-truncation on context limit errors |

**Anthropic-Specific (via config.yaml):**

These options are configured in `config.yaml` under the `anthropic:` section. See [`config.example.yaml`](config.example.yaml).

| Config Key | Default | Description |
|------------|---------|-------------|
| `anthropic.rewrite_tools` | true | Rewrite server-side tools to custom format |
| `stream_idle_timeout` | 300 | Max seconds between SSE events (0 = no timeout) |

**Sanitization:**

| Option | Default | Description |
|--------|---------|-------------|
| `--collect-system-prompts` | false | Collect system prompts to file |

**Rate Limiting:**

| Option | Default | Description |
|--------|---------|-------------|
| `--no-rate-limit` | enabled | Disable adaptive rate limiting |

Rate limiter sub-parameters are configured in `config.yaml` under `rate_limiter:`. See [`config.example.yaml`](config.example.yaml).

## Configuration

Create a `config.yaml` in the working directory. See [`config.example.yaml`](config.example.yaml) for all available options.

## API Endpoints

### OpenAI Compatible

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions |
| `/v1/responses` | POST | Responses API |
| `/v1/models` | GET | List available models |
| `/v1/models/:model` | GET | Get specific model details |
| `/v1/embeddings` | POST | Text embeddings |

All endpoints also work without the `/v1` prefix.

### Anthropic Compatible

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Messages API |
| `/v1/messages/count_tokens` | POST | Token counting |

### Utility

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (200 healthy, 503 unhealthy) |
| `/usage` | GET | Copilot usage and quota statistics |
| `/token` | GET | Current Copilot token information |
| `/history/v3/` | GET | History web UI |
| `/history/ws` | WebSocket | Real-time history updates |
| `/history/api/entries` | GET | Query history entries |
| `/history/api/entries/:id` | GET | Get single entry |
| `/history/api/summaries` | GET | Entry summaries |
| `/history/api/stats` | GET | Usage statistics |
| `/history/api/sessions` | GET | List sessions |

## Account Types

The account type determines the Copilot API base URL:

| Type | API Base URL |
|------|-------------|
| `individual` | `api.githubcopilot.com` |
| `business` | `api.business.githubcopilot.com` |
| `enterprise` | `api.enterprise.githubcopilot.com` |

## License

[MIT](LICENSE)
