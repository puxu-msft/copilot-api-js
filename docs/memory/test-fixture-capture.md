# Test Fixture Capture - Execution Context

## Server Info
- Server running at localhost:4141
- History API at /history/api/

## History API Endpoints (from src/routes/history/api.ts)
- GET /history/api/sessions — List all sessions
- GET /history/api/sessions/:id — Get session with entries
- GET /history/api/entries — List entries (with pagination)
- GET /history/api/entries/:id — Get single entry with full data

## API Endpoints to Test
1. POST /v1/messages — Anthropic Messages (direct, Claude models only)
2. POST /chat/completions — OpenAI Chat Completions (direct, all models)
3. POST /v1/responses — OpenAI Responses (direct, codex/gpt-5 models)

## Test Requests to Send

### 1. Anthropic Messages - Simple
```bash
curl -s http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: test" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4","max_tokens":100,"messages":[{"role":"user","content":"Say hello in exactly 3 words"}]}'
```

### 2. Chat Completions - Simple
```bash
curl -s http://localhost:4141/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Say hello in exactly 3 words"}],"max_tokens":100}'
```

### 3. OpenAI Responses - Simple
```bash
curl -s http://localhost:4141/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5","input":"Say hello in exactly 3 words","max_output_tokens":100}'
```

## Fixture Directory Structure
tests/fixtures/
├── anthropic-messages/simple/   (request.json + response.json)
├── openai-chat-completions/simple/  (request.json + response.json)
└── openai-responses/simple/     (request.json + response.json)

## After Capture
- Use history API to get full request/response data for each entry
- Save as fixture files
- Build factories and tests from real data
