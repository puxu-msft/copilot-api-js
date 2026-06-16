# Test Writing Progress

## Current Status (2026-03-02)
879 tests all passing, 0 failures. Now adding missing P0/P1 tests.

## P0 Tests To Write

### 1. token-refresh strategy (src/lib/request/strategies/token-refresh.ts)
- `createTokenRefreshStrategy<T>()` returns RetryStrategy
- `canHandle(error)`: returns true only for `auth_expired` type, false after first refresh
- `handle()`: calls `getCopilotTokenManager().refresh()`, returns retry on success, abort on failure
- hasRefreshed flag prevents double-refresh
- Key: needs mock of `getCopilotTokenManager`

### 2. deferred-tool-retry strategy (src/lib/request/strategies/deferred-tool-retry.ts)
- `parseToolReferenceError(msg)`: extracts tool name from error message
- `createDeferredToolRetryStrategy<T>()`: handles 400 bad_request with tool reference errors
- `canHandle()`: checks error.type=bad_request, status=400, parses responseText for tool name
- `handle()`: finds tool in payload, sets defer_loading:false, retries
- Tracks undeferred tools to avoid infinite loops
- Key: needs payload with tools array

### 3. context consumers (src/lib/context/consumers.ts)
- `registerContextConsumers(manager)`: wires RequestContextManager events to history + tui
- Listens for 'created', 'updated', 'completed', 'failed' events
- On 'created': inserts history entry via addEntry()
- On 'updated'/'completed'/'failed': updates entry via updateEntry()
- Key: needs mock of history store and tui tracker

## P1 Tests To Write

### 4. OpenAI stream accumulator (src/lib/openai/stream-accumulator.ts)
- `createOpenAIStreamAccumulator()`: initializes accumulator state
- `accumulateOpenAIStreamEvent(chunk, acc)`: processes ChatCompletionChunk
- Handles: content, tool_calls (function name + arguments), model, finish_reason, usage
- Multiple tool calls with index-based accumulation

### 5. recording (buildAnthropicResponseData, buildOpenAIResponseData)
- Already has buildResponsesResponseData tests
- Need analogous tests for the other two formats

## Pipeline Types Reference
```typescript
interface RetryStrategy<T> {
  name: string
  canHandle(error: ApiError): boolean
  handle(error: ApiError, payload: T, context: RetryContext<T>): Promise<RetryAction<T>>
}

interface ApiError {
  type: string   // 'auth_expired' | 'bad_request' | ...
  status: number
  message: string
  raw?: unknown
}
```
