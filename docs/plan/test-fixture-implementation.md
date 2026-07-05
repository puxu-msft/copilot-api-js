# Test Fixture Implementation Plan

## Goal
Capture real Copilot API request/response pairs as test fixtures for snapshot-based regression testing.

## Proposed Structure
```
tests/fixtures/
├── anthropic-messages/
│   ├── simple/
│   │   ├── request.json              # MessagesPayload
│   │   ├── response.json             # Full API response (non-streaming)
│   │   └── stream-events.jsonl       # One SSE event per line
│   └── tool-use/
│       ├── request.json
│       ├── response.json
│       ├── followup-request.json     # With tool_result
│       └── followup-response.json
├── openai-chat-completions/
│   ├── simple/
│   │   ├── request.json
│   │   ├── response.json
│   │   └── stream-chunks.jsonl
│   └── tool-call/
│       ├── request.json
│       ├── response.json
│       ├── followup-request.json
│       └── followup-response.json
└── openai-responses/
    ├── simple/
    │   ├── request.json
    │   ├── response.json
    │   └── stream-events.jsonl
    └── function-call/
        ├── request.json
        ├── response.json
        ├── followup-request.json
        └── followup-response.json
```

## Capture Approach
Create `scripts/capture-fixtures.ts` that:
1. Uses existing clients (createAnthropicMessages, createChatCompletions, createResponses)
2. Sends real requests to Copilot API
3. Saves request payload + raw response as JSON
4. For streaming, saves each SSE event as a line in .jsonl
5. Run once to populate, commit to repo

## Current Infrastructure
- `tests/helpers/factories.ts` — Only Chat Completions mocks (mockOpenAIPayload, mkResponse, mkChunk)
- `tests/helpers/fake-stream.ts` — Fake async stream generator
- `src/lib/request/recording.ts` — Has build*ResponseData for all 3 formats
- `refs/` — Raw samples (200 response.json, TOOL_RESULT_USER_MSG.json, etc.)

## Implementation Steps
1. Create `tests/fixtures/` directory structure
2. Build capture script
3. Add fixture loader utility to tests/helpers/
4. Add Anthropic + Responses factories to factories.ts
5. Write component tests using real fixtures
6. Write accumulator consistency tests (stream events → same result as non-streaming)
