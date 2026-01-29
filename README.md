# Copilot API Proxy (Fork)

> [!NOTE]
> This is a fork of [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) with additional improvements and bug fixes.

> [!WARNING]
> This is a reverse-engineered proxy of GitHub Copilot API. It is not supported by GitHub, and may break unexpectedly. Use at your own risk.

## Fork Improvements

This fork includes the following enhancements over the upstream project:

### New Features

- **`--host` option**: Bind the server to a specific network interface (e.g., `--host 0.0.0.0` for all interfaces, `--host 127.0.0.1` for localhost only)
- **Adaptive rate limiting**: Smart rate limiting with exponential backoff, auto-recovery, and Retry-After support (replaces queue-based limiting)
- **Direct Anthropic API**: Claude models use Copilot's native Anthropic endpoint without translation overhead
- **Smart auto-truncate**: Automatically truncates conversation history when exceeding context limits, with optional tool result compression
- **`/v1/event_logging/batch` endpoint**: Compatibility endpoint for Anthropic SDK's event logging (returns OK without processing)
- **`logout` command**: Remove stored GitHub token with `copilot-api logout`
- **`patch-claude` command**: Patch Claude Code's context window limit to match Copilot's limits
- **Tool name length handling**: Automatically truncates long tool names (>64 chars) to comply with OpenAI's limit, with hash-based suffix to avoid collisions. Original names are restored in responses.
- **Request History UI**: Built-in Web UI (enabled by default) to view, search, filter, and export all API requests/responses. Access at `/history`.

### Bug Fixes

- **Fixed missing `model` field in streaming**: The first streaming chunk from Copilot API sometimes has an empty `choices` array but contains the model name. We now store this for use in subsequent events.
- **Auto-fix message sequence errors**: When tool calls are interrupted (e.g., by user cancel), the API now automatically adds placeholder `tool_result` blocks to maintain valid message sequences
- **Fixed `bunx` symlink issue**: Changed pre-commit hook to use `bun x` instead of `bunx` for better compatibility

### Documentation

- Added [CLAUDE.md](./CLAUDE.md) with project architecture documentation

## Quick Start

### Install from npm (Recommended)

```sh
# Run directly with npx
npx @hsupu/copilot-api start

# Or install globally
npm install -g @hsupu/copilot-api
copilot-api start
```

### Install from GitHub

You can also install directly from GitHub (requires build step):

```sh
npm install -g github:puxu-msft/copilot-api-js
copilot-api start
```

### Running from Source

```sh
# Clone the repository
git clone https://github.com/puxu-msft/copilot-api-js.git
cd copilot-api-js

# Install dependencies
bun install

# Development mode (with hot reload)
bun run dev

# Production mode
bun run start

# Build for distribution
bun run build
```

### After Building

```sh
# Run the built version locally
npx .

# Or link globally
bun link
copilot-api start
```

## Command Reference

| Command | Description |
|---------|-------------|
| `start` | Start the API server (handles auth if needed) |
| `auth` | Run GitHub authentication flow only |
| `logout` | Remove stored GitHub token |
| `check-usage` | Show Copilot usage and quota |
| `debug` | Display diagnostic information |
| `patch-claude` | Patch Claude Code's context window limit |

### Start Command Options

| Option | Description | Default |
|--------|-------------|---------|
| `--port`, `-p` | Port to listen on | 4141 |
| `--host`, `-H` | Host/interface to bind to | (all interfaces) |
| `--verbose`, `-v` | Enable verbose logging | false |
| `--account-type`, `-a` | Account type (individual, business, enterprise) | individual |
| `--manual` | Manual request approval mode | false |
| `--no-rate-limit` | Disable adaptive rate limiting | false |
| `--retry-interval` | Seconds to wait before retrying after rate limit | 10 |
| `--request-interval` | Seconds between requests in rate-limited mode | 10 |
| `--recovery-timeout` | Minutes before attempting recovery | 10 |
| `--consecutive-successes` | Successes needed to exit rate-limited mode | 5 |
| `--github-token`, `-g` | Provide GitHub token directly | none |
| `--claude-code`, `-c` | Generate Claude Code launch command | false |
| `--show-token` | Show tokens on fetch/refresh | false |
| `--proxy-env` | Use proxy from environment | false |
| `--no-history` | Disable request history UI at `/history` | false |
| `--history-limit` | Max history entries in memory | 1000 |
| `--no-auto-truncate` | Disable auto-truncate when exceeding limits | false |
| `--compress-tool-results` | Compress old tool results before truncating | false |
| `--redirect-anthropic` | Force Anthropic through OpenAI translation | false |
| `--no-rewrite-anthropic-tools` | Don't rewrite server-side tools | false |

### Patch-Claude Command Options

| Option | Description | Default |
|--------|-------------|---------|
| `--limit`, `-l` | Context window limit in tokens | 128000 |
| `--restore`, `-r` | Restore original 200k limit | false |
| `--path`, `-p` | Path to Claude Code cli.js | auto-detect |
| `--status`, `-s` | Show current patch status | false |

## API Endpoints

### OpenAI Compatible

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions |
| `/v1/models` | GET | List available models |
| `/v1/embeddings` | POST | Text embeddings |

### Anthropic Compatible

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Messages API |
| `/v1/messages/count_tokens` | POST | Token counting |
| `/v1/event_logging/batch` | POST | Event logging (no-op) |

### Utility

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server status |
| `/usage` | GET | Copilot usage stats |
| `/token` | GET | Current Copilot token |
| `/health` | GET | Health check |
| `/history` | GET | Request history Web UI (enabled by default) |
| `/history/api/*` | GET/DELETE | History API endpoints |

## Using with Claude Code

Create `.claude/settings.json` in your project:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-4.1",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": ["WebSearch"]
  }
}
```

Or use the interactive setup:

```sh
bun run start --claude-code
```

## Upstream Project

For the original project documentation, features, and updates, see: [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)
