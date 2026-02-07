# AGENTS.md

重要：使用中文与用户交流、回答和展示思考。
重要：使用中文与用户交流、回答和展示思考。
重要：使用中文与用户交流、回答和展示思考。

## Rules

- **Always use the best, most complete solution.**
  Never take shortcuts or use workaround approaches. Always think deeply and choose the optimal implementation.
  - **Fix root causes, not symptoms.** Investigate why something doesn't work and fix the underlying mechanism, rather than adding workarounds or hardcoding fallback values.
  - **Prefer robust, maintainable solutions.** Even if a quick hack would work, choose the approach that is correct, complete, and future-proof.
  - **Lint serves readability, not the other way around.** If a lint rule doesn't improve readability, disable it rather than contorting the code to satisfy it.

- **Never start the server.**
  Do not run `bun run dev`, `bun run start`, or any command that starts the server. If you need to verify server behavior, ask the user to start it. You may run non-server commands like `bun run typecheck`, `bun run lint:all`, `bun test`, etc.

- **Never kill running project processes.**
  Do not use `kill`, `pkill`, `killall`, or similar commands to terminate a running instance of this project. If you need to restart, ask the user to do it manually.

- **Never auto-stage or unstage git changes.**
  Do not run `git add`, `git reset`, `git restore --staged`, or any command that modifies the git staging area unless the user explicitly asks you to commit. Leave all staging decisions to the user.

## Commands

```sh
bun install              # Install dependencies
bun run dev              # Development mode (hot reload)
bun run start            # Production mode
bun run build            # Build for distribution (tsdown)
bun run typecheck        # Type checking
bun run lint             # Lint staged files
bun run lint:all         # Lint all files
bun run knip             # Find unused exports/dependencies
bun test                 # Run all tests
bun test tests/foo.test.ts  # Run single test file
```

## Code Style

- Uses `@echristian/eslint-config` with Prettier. Run `eslint --fix` to auto-format (do NOT use `prettier --write` directly).
- No semicolons. Ternary operator at start of line.
- Strict TypeScript (`strict: true`). Avoid `any`.
- ESNext modules, no CommonJS. Path alias `~/*` maps to `src/*`.
- Tests: Bun's built-in test runner. Place tests in `tests/`, name as `*.test.ts`.
- Error handling: Use explicit error classes (see `src/lib/error.ts`). Avoid silent failures.

## Project Overview

A reverse-engineered proxy for the GitHub Copilot API that exposes it as OpenAI and Anthropic compatible endpoints. This allows tools like Claude Code to use GitHub Copilot as their backend.

## Architecture

### Entry Points

- `src/main.ts` - CLI entry point (citty), subcommands: `start`, `auth`, `logout`, `check-usage`, `debug`, `list-claude-code`, `setup-claude-code`
- `src/start.ts` - Server startup: authentication, model caching, launches Hono server via srvx
- `src/server.ts` - Hono app configuration, registers all routes

### Request Flow

1. Incoming requests hit Hono routes in `src/routes/`
2. For Anthropic-compatible `/v1/messages` endpoint:
   - **Direct path**: Claude models go to Copilot's native Anthropic endpoint (`direct-anthropic-handler.ts`)
   - **Translation path**: Other models are translated Anthropic -> OpenAI -> Copilot -> OpenAI -> Anthropic (`translated-handler.ts`)
3. OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) proxy directly to Copilot API
4. All requests go through adaptive rate limiting (`executeWithAdaptiveRateLimit`)
5. Auto-truncate can be enabled to compact context when it exceeds token or byte limits

### Key Modules

- `lib/state.ts` - Global mutable state (tokens, config, rate limiting, auto-truncate settings)
- `lib/token/` - GitHub OAuth device flow and Copilot token management with auto-refresh
- `lib/api-config.ts` - Copilot API URLs and headers (emulates VSCode extension)
- `lib/adaptive-rate-limiter.ts` - Adaptive rate limiting with exponential backoff (3 modes: Normal, Rate-limited, Recovering)
- `lib/history.ts` + `lib/history-ws.ts` - Request/response history recording, querying, export (JSON/CSV), and WebSocket live updates
- `lib/tui/` - Terminal UI for request logging, console output with ASCII prefixes
- `lib/auto-truncate/` - Auto-truncate: `common.ts` (shared config, dynamic limits), `openai.ts` / `anthropic.ts` (format-specific)
- `lib/tokenizer.ts` - Token counting via GPT tokenizers, image token calculation
- `lib/message-sanitizer/` - Modular message sanitization: system-reminder tag removal, orphan tool block filtering for both regular (`tool_use`/`tool_result`) and server-side (`server_tool_use`/`*_tool_result`) blocks, double-serialized input repair, corrupted block cleanup (separate implementations for Anthropic and OpenAI formats)
- `lib/shutdown.ts` - Graceful shutdown with connection draining

### Services

- `services/github/` - GitHub API interactions (auth, device code, user info, usage stats)
- `services/copilot/` - Copilot API calls (chat completions, Anthropic messages, models, embeddings)
- `services/get-vscode-version.ts` - Fetches latest VSCode version for API headers

## Design Principles

### Console Output

- **Use fixed-width ASCII prefixes** for log alignment, not emoji/icons (e.g., `[....]`, `[<-->]`, `[ OK ]`, `[FAIL]`)
- **Log format**: `[PREFIX] HH:MM:SS METHOD /path ...` - status prefix comes first, then timestamp
- **Only show relevant info**: Non-model requests (like `/health`) should not display model name, tokens, or "unknown"
- **Streaming indicator**: Show `streaming...` status for long-running requests with `[<-->]` prefix

### History Web UI

- **Show actual request content**: If the last message is `tool_result`, display `[tool_result: id]` instead of searching backwards for user text
- **Prefer text over tool_use**: For assistant messages with both text and tool_use, show the text content first; only show `[tool_use: ToolName]` if there's no text
- **Filter system tags**: Remove `<system-reminder>`, `<ide_opened_file>`, and other system tags from preview text

### General Principles

- **Minimize noise**: Don't display redundant or unavailable information
- **Consistent formatting**: Use fixed-width columns for alignment in console output
- **Informative previews**: History previews should reflect the actual nature of the request
- **Informative logs**: All log messages should include enough context (module tag, model name, specific values) to be actionable

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/v1/chat/completions` | OpenAI-compatible chat |
| `/v1/messages` | Anthropic-compatible messages |
| `/v1/messages/count_tokens` | Anthropic-compatible token counting |
| `/v1/models` | List available models |
| `/v1/embeddings` | Text embeddings |
| `/usage` | Copilot quota/usage stats |
| `/health` | Health check |
| `/token` | Current Copilot token info |
| `/history` | Request history Web UI (v1 and v2) |
| `/history/ws` | WebSocket for real-time history updates |
| `/history/api/entries` | History query API |
| `/history/api/sessions` | Session list API |
| `/history/api/stats` | Statistics API |
| `/history/api/export` | Export history (JSON/CSV) |

## Anthropic API Compatibility

Two paths:
- **Direct** (Claude models -> Copilot's native Anthropic endpoint)
- **Translation** (other models -> OpenAI format conversion).

Some Anthropic features have limited or no support due to Copilot API constraints:

| Feature | Support | Notes |
|---------|---------|-------|
| Prompt Caching | Partial | Read-only; `cache_read_input_tokens` is reported from Copilot's `cached_tokens`. Cannot set `cache_control` to mark cacheable content. |
| Batch Processing | Not supported | Copilot API lacks batch support. |
| Extended Thinking | Partial | `thinking` parameter is forwarded to Copilot API; whether the backend generates thinking blocks depends on Copilot. |
| Server-side Tools | Partial | All server tool types (e.g., `web_search`, `tool_search`) are supported. Tools are rewritten to custom format (disable with `--no-rewrite-anthropic-tools`). The sanitizer handles all `server_tool_use`/`*_tool_result` pairs generically via duck-typing (`isServerToolResultBlock`). |

### Model Name Translation

The system translates model names sent by clients to match available Copilot models:

- **Short aliases**: `opus` -> best available opus, `sonnet` -> best available sonnet, `haiku` -> best available haiku
- **Hyphenated versions**: `claude-opus-4-6` -> `claude-opus-4.6`, `claude-sonnet-4-5` -> `claude-sonnet-4.5`
- **Date-suffixed versions**: `claude-sonnet-4-5-20250514` -> `claude-sonnet-4.5`, `claude-opus-4-20250514` -> best available opus
- **Direct names**: `claude-sonnet-4`, `gpt-4` etc. pass through unchanged

Each model family has a preference list (`MODEL_PREFERENCE` in `non-stream-translation.ts`). When using short aliases, the first available model from the preference list is selected.

## Key Configuration

Account types affect the Copilot API base URL:
- `individual` -> `api.githubcopilot.com`
- `business` -> `api.business.githubcopilot.com`
- `enterprise` -> `api.enterprise.githubcopilot.com`

Key runtime options in `lib/state.ts`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoTruncate` | boolean | `true` | Reactive auto-truncate: retries with truncated payload on limit errors, pre-checks for models with known limits |
| `compressToolResults` | boolean | `true` | Compress old tool_result content before truncating messages |
| `redirectAnthropic` | boolean | `false` | Force Anthropic requests through OpenAI translation |
| `rewriteAnthropicTools` | boolean | `true` | Rewrite server-side tools (web_search) to custom format |

## Syncing with Upstream

本地仓库来自开源项目 https://github.com/ericc-ch/copilot-api ，你也应该检查在线的 issues、PR，分析他们描述的问题是否真实存在、他们修复的问题是否值得合并。为了实现这个，你可以使用 gh 命令。
