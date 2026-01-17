# CLAUDE.md

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

- `src/main.ts` - CLI entry point using citty, defines subcommands: `start`, `auth`, `logout`, `check-usage`, `debug`
- `src/start.ts` - Main server startup logic, handles authentication flow, model caching, and launches Hono server via srvx
- `src/server.ts` - Hono app configuration, registers all routes

### Request Flow

1. Incoming requests hit Hono routes in `src/routes/`
2. For Anthropic-compatible `/v1/messages` endpoint:
   - `routes/messages/handler.ts` receives Anthropic payload
   - Translates to OpenAI format via `non-stream-translation.ts`
   - Calls `services/copilot/create-chat-completions.ts`
   - Translates response back to Anthropic format (streaming uses `stream-translation.ts`)
3. OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) proxy directly to Copilot API

### Key Modules

- `lib/state.ts` - Global mutable state (tokens, config, rate limiting)
- `lib/token.ts` - GitHub OAuth device flow and Copilot token management with auto-refresh
- `lib/api-config.ts` - Copilot API URLs and headers (emulates VSCode extension)
- `lib/queue.ts` - Request queue for rate limiting (queues requests instead of rejecting)
- `lib/history.ts` - Request/response history recording and querying
- `lib/tui/` - Terminal UI module for request logging (replaces hono/logger)
  - `types.ts` - Type definitions for request tracking (`TrackedRequest`, `TuiRenderer`)
  - `tracker.ts` - Singleton request state manager
  - `console-renderer.ts` - Console output with timestamps and ASCII prefixes (`[....]`, `[<-->]`, `[ OK ]`, `[FAIL]`)
  - `middleware.ts` - Hono middleware for automatic request tracking
  - `index.ts` - TUI initialization
- `lib/approval.ts` - Manual request approval flow
- `lib/tokenizer.ts` - Token counting for Anthropic `/v1/messages/count_tokens` endpoint
- `lib/error.ts` - HTTP error handling utilities
- `lib/paths.ts` - File system paths for token storage
- `lib/proxy.ts` - HTTP proxy configuration support

### Services

- `services/github/` - GitHub API interactions (auth, device code, user info, usage stats)
- `services/copilot/` - Copilot API calls (chat completions, embeddings, models)
- `services/get-vscode-version.ts` - Fetches latest VSCode version from GitHub API for API headers

### Path Aliases

The project uses `~/` as an alias for `./src/` (configured in tsconfig.json).

## Code Style

This project uses `@echristian/eslint-config` with strict formatting rules:

- **No semicolons** - The prettier config has `semi: false`
- **No trailing commas in single-line** - But required in multi-line
- **Ternary operator position** - `experimentalOperatorPosition: "start"` (operator at start of line)
- Use `eslint --fix` to auto-format code (do NOT use `prettier --write` directly as it uses different defaults)

Key linting rules:
- `max-lines-per-function: 100` - Functions should be under 100 lines
- `max-params: 3` - Functions should have at most 3 parameters
- `complexity: 16` - Maximum cyclomatic complexity
- `Array<T>` syntax preferred over `T[]`
- `Number.parseInt()` instead of `parseInt()`
- `!== -1` instead of `>= 0` for index checks

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/v1/chat/completions` | OpenAI-compatible chat |
| `/v1/messages` | Anthropic-compatible messages |
| `/v1/messages/count_tokens` | Anthropic-compatible token counting |
| `/v1/models` | List available models |
| `/v1/embeddings` | Text embeddings |
| `/usage` | Copilot quota/usage stats |
| `/token` | Current Copilot token |
| `/health` | Health check for container orchestration |
| `/api/event_logging/batch` | Anthropic SDK telemetry (returns 200 OK) |
| `/history` | Request history Web UI (requires `--history` flag) |
| `/history/api/*` | History query API endpoints |

## Anthropic API Compatibility

The `/v1/messages` endpoint translates between Anthropic and OpenAI formats. Some Anthropic features have limited or no support due to Copilot API constraints:

| Feature | Support | Notes |
|---------|---------|-------|
| Prompt Caching | Partial | Read-only; `cache_read_input_tokens` is reported from Copilot's `cached_tokens`. Cannot set `cache_control` to mark cacheable content. |
| Extended Thinking | Not supported | `thinking` parameter is ignored. Thinking blocks in history are converted to plain text. |
| Batch Processing | Not supported | No `/v1/messages/batches` endpoint; Copilot API lacks batch support. |

### Model Name Translation

The translation layer maps Anthropic model names to Copilot-compatible formats:
- Short aliases: `opus` → `claude-opus-4.5`, `sonnet` → `claude-sonnet-4.5`, `haiku` → `claude-haiku-4.5`
- Versioned names: `claude-sonnet-4-20250514` → `claude-sonnet-4`, `claude-opus-4-5-20250101` → `claude-opus-4.5`

## Key Configuration

Account types affect the Copilot API base URL:
- `individual` → `api.githubcopilot.com`
- `business` → `api.business.githubcopilot.com`
- `enterprise` → `api.enterprise.githubcopilot.com`

## Syncing with Upstream

本地仓库来自开源项目 https://github.com/ericc-ch/copilot-api ，你也应该检查在线的 issues、PR，分析他们描述的问题是否真实存在、他们修复的问题是否值得合并。为了实现这个，你可以使用 gh 命令。
