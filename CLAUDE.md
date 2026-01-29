# CLAUDE.md

使用中文与用户交流。

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Core Principles (HIGHEST PRIORITY)

**Always use the best, most complete solution.** Never take shortcuts or workarounds:
- Always think deeply and choose the optimal approach
- If code violates lint rules, refactor the code properly
- Fix the root cause, not the symptom
- Prefer robust, maintainable solutions over quick hacks

## Project Overview

A reverse-engineered proxy for the GitHub Copilot API that exposes it as OpenAI and Anthropic compatible endpoints. This allows tools like Claude Code to use GitHub Copilot as their backend.

## Design Principles

### Console Output Design

- **Use fixed-width ASCII prefixes** for log alignment, not emoji/icons (e.g., `[....]`, `[<-->]`, `[ OK ]`, `[FAIL]`)
- **Log format**: `[PREFIX] HH:MM:SS METHOD /path ...` - status prefix comes first, then timestamp
- **Only show relevant info**: Non-model requests (like `/health`) should not display model name, tokens, or "unknown"
- **Streaming indicator**: Show `streaming...` status for long-running requests with `[<-->]` prefix

### History UI Design

- **Show actual request content**: If the last message is `tool_result`, display `[tool_result: id]` instead of searching backwards for user text
- **Prefer text over tool_use**: For assistant messages with both text and tool_use, show the text content first; only show `[tool_use: ToolName]` if there's no text
- **Filter system tags**: Remove `<system-reminder>`, `<ide_opened_file>`, and other system tags from preview text

### General Principles

- **Minimize noise**: Don't display redundant or unavailable information
- **Consistent formatting**: Use fixed-width columns for alignment in console output
- **Informative previews**: History previews should reflect the actual nature of the request

## Development Commands

```sh
# Install dependencies
bun install

# Development mode (with hot reload)
bun run dev

# Production mode
bun run start

# Build for distribution
bun run build

# Type checking
bun run typecheck

# Linting
bun run lint           # staged files
bun run lint:all       # all files

# Find unused exports/dependencies
bun run knip
```

## Architecture

### Entry Points

- `src/main.ts` - CLI entry point using citty, defines subcommands: `start`, `auth`, `logout`, `check-usage`, `debug`, `patch-claude`
- `src/start.ts` - Main server startup logic, handles authentication flow, model caching, and launches Hono server via srvx
- `src/server.ts` - Hono app configuration, registers all routes
- `src/patch-claude-code.ts` - Claude Code context window patching tool

### Request Flow

1. Incoming requests hit Hono routes in `src/routes/`
2. For Anthropic-compatible `/v1/messages` endpoint:
   - `routes/messages/handler.ts` receives Anthropic payload
   - Checks if model supports direct Anthropic API via `supportsDirectAnthropicApi()`
   - **Direct path**: `direct-anthropic-handler.ts` sends to Copilot's native Anthropic endpoint
   - **Translation path**: `translated-handler.ts` translates to OpenAI format via `non-stream-translation.ts`, calls `services/copilot/create-chat-completions.ts`, then translates response back (streaming uses `stream-translation.ts`)
3. OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) proxy directly to Copilot API
4. All requests go through adaptive rate limiting (`executeWithAdaptiveRateLimit`)
5. Auto-truncate is applied when context exceeds limits (uses `auto-truncate-openai.ts` or `auto-truncate-anthropic.ts`)

### Key Modules

- `lib/state.ts` - Global mutable state (tokens, config, rate limiting, auto-truncate settings)
- `lib/token.ts` - GitHub OAuth device flow and Copilot token management with auto-refresh
- `lib/api-config.ts` - Copilot API URLs and headers (emulates VSCode extension)
- `lib/adaptive-rate-limiter.ts` - Adaptive rate limiting with exponential backoff (3 modes: Normal, Rate-limited, Recovering)
- `lib/history.ts` - Request/response history recording, querying, and export (JSON/CSV)
- `lib/tui/` - Terminal UI module for request logging (replaces hono/logger)
  - `types.ts` - Type definitions for request tracking (`TrackedRequest`, `TuiRenderer`)
  - `tracker.ts` - Singleton request state manager
  - `console-renderer.ts` - Console output with timestamps and ASCII prefixes (`[....]`, `[<-->]`, `[ OK ]`, `[FAIL]`)
  - `middleware.ts` - Hono middleware for automatic request tracking
  - `index.ts` - TUI initialization
- `lib/approval.ts` - Manual request approval flow
- `lib/auto-truncate-common.ts` - Shared auto-truncate configuration and dynamic limit adjustment
- `lib/auto-truncate-openai.ts` - Auto-truncate for OpenAI format messages (message compression, tool result compression)
- `lib/auto-truncate-anthropic.ts` - Auto-truncate for Anthropic format messages
- `lib/tokenizer.ts` - Token counting with multiple tokenizers (GPT: o200k/cl100k/p50k/r50k, Anthropic), image token calculation
- `lib/error.ts` - HTTP error handling utilities (includes 413/400 error for auto-truncate triggering)
- `lib/paths.ts` - File system paths for token storage
- `lib/proxy.ts` - HTTP proxy configuration support
- `lib/shell.ts` - Shell command generation for environment setup (e.g., Claude Code launch command)

### Services

- `services/github/` - GitHub API interactions (auth, device code, user info, usage stats)
- `services/copilot/` - Copilot API calls:
  - `create-chat-completions.ts` - OpenAI-compatible chat completions
  - `create-anthropic-messages.ts` - Direct Anthropic API support with tool rewriting
  - `get-models.ts` - Model listing with capability detection
  - `create-embeddings.ts` - Text embeddings
- `services/get-vscode-version.ts` - Fetches latest VSCode version from GitHub API for API headers

### Path Aliases

The project uses `~/` as an alias for `./src/` (configured in tsconfig.json).

## Code Style

This project uses `@echristian/eslint-config` with formatting rules:

- **No semicolons** - The prettier config has `semi: false`
- **No trailing commas in single-line** - But required in multi-line
- **Ternary operator position** - `experimentalOperatorPosition: "start"` (operator at start of line)
- Use `eslint --fix` to auto-format code (do NOT use `prettier --write` directly as it uses different defaults)

Key linting rules:
- `Array<T>` syntax preferred over `T[]`
- `Number.parseInt()` instead of `parseInt()`
- `!== -1` instead of `>= 0` for index checks

Note: Code structure rules like `max-lines-per-function`, `max-params`, `max-depth`, and `complexity` are disabled to allow for more natural code organization.

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/` | Server status |
| `/v1/chat/completions` | OpenAI-compatible chat |
| `/v1/messages` | Anthropic-compatible messages |
| `/v1/messages/count_tokens` | Anthropic-compatible token counting |
| `/v1/models` | List available models |
| `/v1/embeddings` | Text embeddings |
| `/usage` | Copilot quota/usage stats |
| `/token` | Current Copilot token |
| `/health` | Health check for container orchestration |
| `/api/event_logging/batch` | Anthropic SDK telemetry (returns 200 OK) |
| `/history` | Request history Web UI (enabled by default, disable with `--no-history`) |
| `/history/api/entries` | History query API |
| `/history/api/sessions` | Session list API |
| `/history/api/stats` | Statistics API |
| `/history/api/export` | Export history (JSON/CSV) |

## Anthropic API Compatibility

The `/v1/messages` endpoint supports two paths:
1. **Direct path**: For Claude models, requests go directly to Copilot's native Anthropic endpoint
2. **Translation path**: For other models, translates between Anthropic and OpenAI formats

Some Anthropic features have limited or no support due to Copilot API constraints:

| Feature | Support | Notes |
|---------|---------|-------|
| Prompt Caching | Partial | Read-only; `cache_read_input_tokens` is reported from Copilot's `cached_tokens`. Cannot set `cache_control` to mark cacheable content. |
| Extended Thinking | Not supported | `thinking` parameter is ignored. Thinking blocks in history are converted to plain text. |
| Batch Processing | Not supported | No `/v1/messages/batches` endpoint; Copilot API lacks batch support. |
| Server-side Tools | Partial | Tools like `web_search` are rewritten to custom tool format (can be disabled with `--no-rewrite-anthropic-tools`). |

### Model Name Translation

The translation layer maps Anthropic model names to Copilot-compatible formats:
- Short aliases: `opus` → `claude-opus-4.5`, `sonnet` → `claude-sonnet-4.5`, `haiku` → `claude-haiku-4.5`
- Versioned names: `claude-sonnet-4-20250514` → `claude-sonnet-4`, `claude-opus-4-5-20250101` → `claude-opus-4.5`

## Key Configuration

Account types affect the Copilot API base URL:
- `individual` → `api.githubcopilot.com`
- `business` → `api.business.githubcopilot.com`
- `enterprise` → `api.enterprise.githubcopilot.com`

### State Configuration Options

Key runtime configuration in `lib/state.ts`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoTruncate` | boolean | `true` | Auto-truncate context when exceeding limits |
| `compressToolResults` | boolean | `false` | Compress old tool_result content before truncating |
| `redirectAnthropic` | boolean | `false` | Force Anthropic requests through OpenAI translation |
| `rewriteAnthropicTools` | boolean | `true` | Rewrite server-side tools (web_search) to custom format |
| `adaptiveRateLimitConfig` | object | - | Rate limiting parameters (retry interval, recovery settings) |

## Syncing with Upstream

本地仓库来自开源项目 https://github.com/ericc-ch/copilot-api ，你也应该检查在线的 issues、PR，分析他们描述的问题是否真实存在、他们修复的问题是否值得合并。为了实现这个，你可以使用 gh 命令。
