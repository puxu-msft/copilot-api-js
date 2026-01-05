# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A reverse-engineered proxy for the GitHub Copilot API that exposes it as OpenAI and Anthropic compatible endpoints. This allows tools like Claude Code to use GitHub Copilot as their backend.

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

- `src/main.ts` - CLI entry point using citty, defines subcommands: `start`, `auth`, `check-usage`, `debug`
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
- `lib/rate-limit.ts` - Request throttling
- `lib/approval.ts` - Manual request approval flow

### Services

- `services/github/` - GitHub API interactions (auth, device code, user info, usage stats)
- `services/copilot/` - Copilot API calls (chat completions, embeddings, models)

### Path Aliases

The project uses `~/` as an alias for `./src/` (configured in tsconfig.json).

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/v1/chat/completions` | OpenAI-compatible chat |
| `/v1/messages` | Anthropic-compatible messages |
| `/v1/models` | List available models |
| `/v1/embeddings` | Text embeddings |
| `/usage` | Copilot quota/usage stats |
| `/token` | Current Copilot token |

## Key Configuration

Account types affect the Copilot API base URL:
- `individual` → `api.githubcopilot.com`
- `business` → `api.business.githubcopilot.com`
- `enterprise` → `api.enterprise.githubcopilot.com`
