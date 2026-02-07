# Copilot API Proxy (Fork)

> [!NOTE]
> This is a fork of [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) with additional improvements and bug fixes.

> [!WARNING]
> This is a reverse proxy for the GitHub Copilot API. It is not officially supported by GitHub and may break at any time. Use at your own risk.

A reverse proxy that exposes GitHub Copilot API as OpenAI and Anthropic compatible API endpoints. Works with Claude Code and other tools that speak OpenAI or Anthropic protocols.

## Quick Start

### Install from npm (Recommended)

```sh
# Run directly
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

- **Direct Anthropic path** — Uses Copilot API's anthropic endpoint
- **Translated path** — Translates to OpenAI format and uses Copilot's OpenAI-compatible endpoint

### Adaptive Rate Limiting

Intelligent rate limiting with exponential backoff, replacing the upstream queue-based approach. Operates in three modes:

- **Normal** — Requests pass through freely
- **Rate-limited** — Queues requests with configurable intervals after hitting limits
- **Recovering** — Gradually resumes normal operation after consecutive successes

Learns from Copilot API's `Retry-After` headers for optimal retry timing.

### Auto-Truncate

Automatically handles context length limits (enabled by default):

- **Reactive** — Retries failed requests with a truncated payload when hitting token or byte limits
- **Proactive** — Pre-checks requests against known model limits before sending
- **Dynamic limit learning** — Adjusts limits based on actual API error responses
- **Tool result compression** — Compresses old `tool_result` content before truncating messages, preserving more conversation context
- Up to 5 retry attempts per request with 2% safety margin

### Message Sanitization

Cleans up messages before forwarding to the API:

- Filters orphaned `tool_use` / `tool_result` blocks (unpaired due to interrupted tool calls or truncation)
- Handles server-side tools (`server_tool_use` / `*_tool_result`) that appear inline in assistant messages
- Fixes double-serialized tool inputs from stream accumulation
- Removes corrupted blocks from older history data
- Fixes tool name casing mismatches
- Removes empty text content blocks
- Strips `<system-reminder>` tags from message content

### Model Name Translation

Translates client-sent model names to matching Copilot models:

| Input | Resolved To |
|-------|-------------|
| `opus`, `sonnet`, `haiku` | Best available model in that family |
| `claude-opus-4-6` | `claude-opus-4.6` |
| `claude-sonnet-4-5-20250514` | `claude-sonnet-4.5` |
| `claude-sonnet-4`, `gpt-4` | Passed through directly |

Each model family has a priority list. Short aliases resolve to the first available model.

### Server-Side Tools

Supports Anthropic server-side tools (e.g., `web_search`, `tool_search`). These tools are executed by the API backend, with both `server_tool_use` and result blocks appearing inline in assistant messages. Tool definitions can optionally be rewritten to a custom format (configurable via `--no-rewrite-anthropic-tools`).

### Request History UI

Built-in web interface for inspecting API requests and responses. Access at `http://localhost:4141/history`.

- Real-time updates via WebSocket
- Filter by model, endpoint, status, and time range
- Full-text search across request/response content
- Export as JSON or CSV
- Session tracking and statistics

### Additional Features

- **Sonnet → Opus redirection** — Optionally redirect sonnet model requests to the best available opus model
- **Security research mode** — Passphrase-protected mode for authorized penetration testing, CTF competitions, and security education
- **Tool name truncation** — Automatically truncates tool names exceeding 64 characters (OpenAI limit) with hash suffixes, restoring original names in responses
- **Health checks** — Container-ready health endpoint at `/health`
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

| Option | Default | Description |
|--------|---------|-------------|
| `--port`, `-p` | 4141 | Port to listen on |
| `--host`, `-H` | (all interfaces) | Host/interface to bind to |
| `--verbose`, `-v` | false | Enable verbose logging |
| `--account-type`, `-a` | individual | Account type: `individual`, `business`, or `enterprise` |
| `--manual` | false | Manual request approval mode |
| `--github-token`, `-g` | | Provide GitHub token directly |
| `--proxy-env` | false | Use proxy from environment variables |
| `--history-limit` | 200 | Max history entries in memory (0 = unlimited) |

**Rate Limiting:**

| Option | Default | Description |
|--------|---------|-------------|
| `--no-rate-limit` | false | Disable adaptive rate limiting |
| `--retry-interval` | 10 | Seconds to wait before retrying after rate limit |
| `--request-interval` | 10 | Seconds between requests in rate-limited mode |
| `--recovery-timeout` | 10 | Minutes before attempting recovery |
| `--consecutive-successes` | 5 | Consecutive successes needed to exit rate-limited mode |

**Auto-Truncate:**

| Option | Default | Description |
|--------|---------|-------------|
| `--no-auto-truncate` | false | Disable auto-truncation on context limit errors |
| `--no-compress-tool-results` | false | Disable tool result compression during truncation |

**Anthropic-Specific:**

| Option | Default | Description |
|--------|---------|-------------|
| `--redirect-anthropic` | false | Force Anthropic requests through OpenAI translation |
| `--no-rewrite-anthropic-tools` | false | Don't rewrite server-side tools to custom format |
| `--redirect-count-tokens` | false | Route count_tokens through OpenAI translation |
| `--redirect-sonnet-to-opus` | false | Redirect sonnet requests to best available opus |
| `--security-research-mode` | | Enable security research mode with passphrase |

## API Endpoints

### OpenAI Compatible

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions |
| `/v1/models` | GET | List available models |
| `/v1/models/:model` | GET | Get specific model details |
| `/v1/embeddings` | POST | Text embeddings |

All endpoints also work without the `/v1` prefix.

### Anthropic Compatible

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Messages API |
| `/v1/messages/count_tokens` | POST | Token counting |
| `/api/event_logging/batch` | POST | Event logging (no-op, returns OK) |

### Utility

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (200 healthy, 503 unhealthy) |
| `/usage` | GET | Copilot usage and quota statistics |
| `/token` | GET | Current Copilot token information |
| `/history` | GET | Request history web UI |
| `/history/ws` | WebSocket | Real-time history updates |
| `/history/api/entries` | GET | Query history entries |
| `/history/api/stats` | GET | Usage statistics |
| `/history/api/export` | GET | Export history (JSON/CSV) |
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
