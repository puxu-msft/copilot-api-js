# Test Fixture Capture - Results So Far

## Completed Requests

### 1. Anthropic Messages ✅
Request: POST /v1/messages, model: claude-sonnet-4, stream: false
Response: Success - got text content "Hello from Anthropic Messages API"
Full response has: content, context_management, id, model, role, stop_reason, stop_sequence, type, usage

### 2. Chat Completions ✅
Request: POST /chat/completions, model: gpt-4o, stream: false
Response: Success - got "Hello from Chat Completions API"
Full response has: choices, id, usage, model, prompt_filter_results, system_fingerprint
Note: Has content_filter_results and padding field in message

### 3. OpenAI Responses ❌
Request: POST /v1/responses, model: gpt-5, stream: false
Response: Error - model_not_supported
Need to try different model. Check AVAILABLE_MODELS.json for models with /responses support.
Candidates: gpt-5-mini, gpt-5.1, gpt-5.2, gpt-5.2-codex, gpt-5.3-codex

## Next Steps
1. Try gpt-5.1 or another model for /responses
2. Get history API entries for the 2 successful requests
3. Save all as fixtures
4. Then send tool-use variants

## History API
- GET /history/api/entries — list entries
- GET /history/api/entries/:id — get entry with full data
