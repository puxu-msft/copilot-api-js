# Translation Framework Research Notes (Updated 2026-03-02)

## Test Infrastructure Audit

### Mock/Factory Helpers (tests/helpers/)
- `factories.ts` — `mockModel()`, `mkResponse()`, `mkChunk()`, `mockOpenAIPayload()`
  - Only Chat Completions format mocks exist
  - **Missing**: Anthropic Messages mock payloads/responses
  - **Missing**: OpenAI Responses mock payloads/responses
- `mock-adapter.ts` — FormatAdapter mock
- `mock-strategy.ts` — Pipeline strategy mock
- `mock-tracker.ts` — TUI tracker mock
- `mock-server.ts` — Server close mock (for shutdown tests)
- `fake-stream.ts` — Fake stream helper

### Reference Data (refs/)
- `200 response.json` — Sample response
- `AVAILABLE_MODELS.json` — Model list with supported_endpoints
- `COMPACTED_USER_MSG.json` — Compacted user message sample
- `TOOL_RESULT_USER_MSG.json` — Tool result message sample
- `SYSTEM_PROMPTS.txt`, `SYSTEM_REMINDER_CASE.txt` — System prompt samples
- `400-full-entity-*.json` — Error response samples

### Direct Channel Test Coverage
| Channel | Has Component Tests | Has E2E Tests | Has Mock Data |
|---------|-------------------|---------------|---------------|
| Direct Anthropic (/v1/messages) | ❌ No dedicated test | ❌ | ❌ No mock factory |
| Direct Chat Completions (/chat/completions) | ✅ chat-completions-service.test.ts | ✅ copilot-api.test.ts | ✅ factories.ts |
| Direct Responses (/v1/responses) | ❌ No dedicated test | ❌ | ❌ No mock factory |

### Key Gap
- factories.ts only has OpenAI Chat Completions mocks
- No Anthropic Messages payload/response factories
- No OpenAI Responses payload/response factories
- No integration tests for direct Anthropic or direct Responses channels

## Current State of Plan
Plan file: `/home/xp/.claude/plans/eager-riding-hamming.md`
- Phase A (directory reorg): ❌ Not started
- Phase B (A→R translation): ❌ Not started
- Phase C (integration/tests): ❌ Not started
- Old translation code: ✅ Fully deleted
- 3 direct channels: ✅ Implemented but under-tested
