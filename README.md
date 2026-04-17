# Copilot API Proxy (Fork)

> [!NOTE]
> This is a fork of [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) with additional improvements and bug fixes.

> [!WARNING]
> This is a reverse proxy for the GitHub Copilot API. It is not officially supported by GitHub and may break at any time. Use at your own risk.

A reverse proxy that exposes GitHub Copilot's API as standard OpenAI and Anthropic compatible endpoints.

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
bun run dev  # Development mode with hot reload
bun run dev:ui  # Development mode for UI
bun run start --port 4141 --external-ui-url http://localhost:5173  # Production mode with separate UI server

# Testing
bun test                   # Backend unit tests
bun run test:all           # All backend tests
bun run test:ui            # Frontend (History UI) tests
bun run typecheck          # TypeScript type checking

# Publish to npm
BROWSER=wslview npm login
BROWSER=wslview npm publish --access public --tag beta
BROWSER=wslview npm dist-tag add @hsupu/copilot-api@0.8.3 latest
```

## Using with Claude Code

Run the interactive setup command:

```sh
copilot-api setup-claude-code
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
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0"
  }
}
```

## Configuration

All `config.yaml`, `github_token` and more are saved in `~/.local/share/copilot-api/`.

See [`config.example.yaml`](config.example.yaml) for all available options.

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
| `--collect-system-prompts` | false | Collect system prompts to file |
| `--no-auto-truncate` | enabled | Disable auto-truncation on context limit errors |
| `--no-rate-limit` | enabled | Disable adaptive rate limiting |

The account type determines the Copilot API base URL:

| Type | API Base URL |
|------|-------------|
| `individual` | `api.githubcopilot.com` |
| `business` | `api.business.githubcopilot.com` |
| `enterprise` | `api.enterprise.githubcopilot.com` |

## API Endpoints

### OpenAI Compatible

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions |
| `/v1/responses` | POST | Responses API |
| `/v1/models` | GET | List available models |
| `/v1/models/:model` | GET | Get specific model details |
| `/v1/embeddings` | POST | Text embeddings |

All endpoints also work without the `/v1` prefix for backwards compatibility.

### Anthropic Compatible

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Messages API |
| `/v1/messages/count_tokens` | POST | Token counting |

### Utility

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (200 healthy, 503 unhealthy) |

## License

[MIT](LICENSE)
