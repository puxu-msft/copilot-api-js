# Copilot API Proxy (Fork)

> [!NOTE]
> This is a fork of [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) with additional improvements and bug fixes.

> [!WARNING]
> This is a reverse-engineered proxy of GitHub Copilot API. It is not supported by GitHub, and may break unexpectedly. Use at your own risk.

## Fork Improvements

This fork includes the following enhancements over the upstream project:

### New Features

- **`--host` option**: Bind the server to a specific network interface (e.g., `--host 0.0.0.0` for all interfaces, `--host 127.0.0.1` for localhost only)
- **Queue-based rate limiting**: Requests are queued and processed sequentially with configurable delays, instead of being rejected when rate limited
- **`/v1/event_logging/batch` endpoint**: Compatibility endpoint for Anthropic SDK's event logging (returns OK without processing)
- **`logout` command**: Remove stored GitHub token with `copilot-api logout`
- **Tool name length handling**: Automatically truncates long tool names (>64 chars) to comply with OpenAI's limit, with hash-based suffix to avoid collisions. Original names are restored in responses.

### Bug Fixes

- **Fixed missing `model` field in streaming**: The first streaming chunk from Copilot API sometimes has an empty `choices` array but contains the model name. We now store this for use in subsequent events.
- **Auto-fix message sequence errors**: When tool calls are interrupted (e.g., by user cancel), the API now automatically adds placeholder `tool_result` blocks to maintain valid message sequences
- **Fixed `bunx` symlink issue**: Changed pre-commit hook to use `bun x` instead of `bunx` for better compatibility

### Documentation

- Added [CLAUDE.md](./CLAUDE.md) with project architecture documentation

## Quick Start

### Running from Source

```sh
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

### Start Command Options

| Option | Description | Default |
|--------|-------------|---------|
| `--port`, `-p` | Port to listen on | 4141 |
| `--host` | Host/interface to bind to | (all interfaces) |
| `--verbose`, `-v` | Enable verbose logging | false |
| `--account-type`, `-a` | Account type (individual, business, enterprise) | individual |
| `--rate-limit`, `-r` | Seconds between requests (uses queue) | none |
| `--wait`, `-w` | Wait in queue instead of rejecting | false |
| `--github-token`, `-g` | Provide GitHub token directly | none |
| `--claude-code`, `-c` | Generate Claude Code launch command | false |
| `--show-token` | Show tokens on fetch/refresh | false |
| `--manual` | Manual request approval mode | false |
| `--proxy-env` | Use proxy from environment | false |

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
| `/usage` | GET | Copilot usage stats |
| `/token` | GET | Current Copilot token |

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

## Docker

```sh
# Build
docker build -t copilot-api .

# Run with persistent token storage
mkdir -p ./copilot-data
docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api

# Run with token from environment
docker run -p 4141:4141 -e GH_TOKEN=your_token copilot-api
```

## Upstream Project

For the original project documentation, features, and updates, see: [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)
