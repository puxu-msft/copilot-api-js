# Show retryable request errors in TUI as `[RETRY-n]` lines

## Context

When a request hits a retryable error (network reset, 413 token limit, deferred tool, legacy thinking, body-field rejection, unsupported beta, expired token, etc.) the pipeline silently retries and only the **final** outcome reaches the TUI — `[ OK ]` if recovery succeeded, `[FAIL]` if it didn't.

This hides real upstream failures that *did* happen. Operators see a normal `[ OK ] 200` line and have no signal that something went wrong upstream that the pipeline papered over. Strategy logs go through `consola.info`, which prints separately, doesn't carry the request's model/duration/status context, and is easy to miss in busy logs.

**User intent**: honestly surface every retry-eligible request failure. The `[RETRY-n]` line means "this failed request has been decided for retry (attempt n)". No strategy is excluded — token-refresh, learning probes, deferred-tool, unsupported-beta all qualify. The final `[ OK ]` / `[FAIL]` outcome line still prints unchanged.

## Approach

### 1. TUI surface — new retry-emission API

The current model is one in-flight entry → one printed completion line. Retries need to print additional lines for the **same entry** without finalizing it. Extend the renderer protocol with an optional `onRequestRetry(entry, info)` hook (default no-op) and add a `tuiLogger.logRetry(id, info)` method that fans out to it. The in-flight entry's `model`, `multiplier`, `method`, `path`, `startTime`, `clientModel` are reused; the retry line carries the failing attempt's `statusCode`, error message, strategy name, attempt number, and optional `waitMs`.

Files:
- [src/lib/tui/types.ts](src/lib/tui/types.ts) — add `RetryInfo` interface (`attempt: number` 1-based, `strategyName: string`, `statusCode: number`, `error: string`, `waitMs?: number`, `learning?: boolean`) + optional `onRequestRetry(entry, info)` on `TuiRenderer`
- [src/lib/tui/tracker.ts](src/lib/tui/tracker.ts) — add `logRetry(id, info)`; no state mutation (entry stays in-flight). Distinct event per call; idempotency not required
- [src/lib/tui/console-renderer.ts](src/lib/tui/console-renderer.ts) — implement `onRequestRetry`; reuse `printLog()` so the footer's `clearFooterForLog → write → renderFooter` three-step is preserved (avoids residual footer artefacts). Render via `formatLogLine` extended with an `isRetry` flag:
  - Prefix `[RETRY-${attempt}]` colored `pc.yellow` (e.g. `[RETRY-1]`, `[RETRY-2]`)
  - Status code colored `pc.red` (it's a failure status)
  - Method/path/model/duration follow the same columns as `[FAIL]`
  - Trailing metadata: `: <error message>` (red, matching `[FAIL]`) + ` ` + `pc.dim("(retryable: <strategy>" + waitSuffix + learningSuffix + ")")` where `waitSuffix` is `, wait 1.0s` when `waitMs > 0` and `learningSuffix` is `, learning` when `info.learning === true`
- [src/lib/tui/format.ts](src/lib/tui/format.ts) — no change; existing `formatTime`/`formatDuration`/`formatBillingLabel` cover the layout
- [src/lib/tui/index.ts](src/lib/tui/index.ts) — re-export `RetryInfo`

Example output:
```
[RETRY-1] 12:34:56 429 POST /v1/messages claude-opus-4.8 (3x) 1.2s ↑15KB: rate_limited (retryable: network-retry, wait 1.0s)
[RETRY-2] 12:34:58 413 POST /v1/messages claude-opus-4.8 (3x) 2.5s ↑15KB: token_limit (retryable: auto-truncate)
[ OK ] 12:35:01 200 POST /v1/messages claude-opus-4.8 (3x) 5.1s ↑15KB ↓3KB ↑1.2K+800 ↓150
```

### 2. Pipeline — emit the retry line at the central choke point

[src/lib/request/pipeline.ts](src/lib/request/pipeline.ts) `executeRequestPipeline` is the single chokepoint that observes (a) the classified `apiError`, (b) the strategy that chose to retry, (c) the `action.learning` flag, (d) the `requestContext` (which carries `tuiLogId`). Centralizing emission here means every handler (messages / chat-completions / responses / gemini / web_search hops) benefits with zero per-handler boilerplate.

Emit **after** the budget gate accepts the retry (so we don't print for actions about to be discarded). Web-search internal hops naturally skip because `requestContext` is `undefined` for those.

```ts
// After budget gate increments normalRetries/learningRetries, before consola.debug:
if (requestContext?.tuiLogId) {
  tuiLogger.logRetry(requestContext.tuiLogId, {
    attempt: execIndex + 1,        // 1-based: "the Nth attempt just failed"
    strategyName: strategy.name,
    statusCode: apiError.status,
    error: apiError.message,
    waitMs: action.waitMs,
    learning: action.learning === true,
  })
}
```

`ApiError.status` and `ApiError.message` are non-optional per [src/lib/error/classify.ts:29-43](src/lib/error/classify.ts#L29-L43), so no undefined handling needed.

Adding `~/lib/tui` import to pipeline.ts is safe: TUI module only depends on `~/lib/{state,utils,models/resolver,shutdown}` + consola/picocolors — no circular dependency.

### 3. Clean up redundant tags in handlers

Handlers currently push `retry-N` / `beta-strip:...` tags onto the in-flight entry via `tuiLogger.updateRequest`, which appear on the final `[ OK ]` line as `(truncated, retry-1, beta-strip:...)`. With per-attempt `[RETRY-n]` lines carrying the same information at higher fidelity, the tags are noise.

Per user direction: clean up. Keep "feature" tags (`thinking:*`, `truncated`), remove "retry counter" tags.

Files:
- [src/routes/messages/handler.ts](src/routes/messages/handler.ts) — in `onRetry` callback (line 274) and `recordRetryPipelineState`, remove `retry-N` tag pushes; keep truncation/thinking tags
- [src/routes/chat-completions/handler.ts](src/routes/chat-completions/handler.ts) — `onRetry` (line 510) currently appends `["truncated", "retry-${attempt+1}"]`; drop `retry-${attempt+1}`, keep `truncated`
- Audit other handlers (gemini, responses) for similar patterns; remove `retry-N` / `beta-strip:` style tags only

### 4. Tests

Per CLAUDE.md test conventions (按域 + 隔离后缀):
- **Add** [tests/pipeline/pipeline-retry-tui.unit.test.ts](tests/pipeline/pipeline-retry-tui.unit.test.ts) — wire a fake `TuiRenderer` via `tuiLogger.setRenderer()` in `beforeEach`, reset in `afterEach`. Reuse mock adapter/strategy patterns from [tests/pipeline/pipeline-with-strategy.unit.test.ts](tests/pipeline/pipeline-with-strategy.unit.test.ts). Assert:
  - Single retry → `onRequestRetry` called once with `attempt:1`, correct `strategyName`, `statusCode`, `error`, `waitMs`, `learning:false`
  - **Multiple retries** (e.g. network-retry → auto-truncate) → 2 calls with `attempt:1` then `attempt:2`
  - Learning-probe retry → `learning:true` in the emitted RetryInfo (still emitted)
  - `action: "abort"` → `onRequestRetry` **not** called
  - No `requestContext` → `onRequestRetry` **not** called
  - First-attempt success → `onRequestRetry` **not** called
  - Budget-exhausted retry → `onRequestRetry` **not** called (gate runs before emit)
- **Add** [tests/tui/console-renderer-retry.unit.test.ts](tests/tui/console-renderer-retry.unit.test.ts) — stub `process.stdout.write`, call `tuiLogger.logRetry(id, info)`, assert:
  - Output contains `[RETRY-1]`, status code, model, error message, `(retryable: ...)` segment
  - Footer three-step preserved: write sequence is `CLEAR_LINE → line+\n → footer-redraw` (or no footer when none active)
  - `waitMs` rendered as `, wait 1.0s` when present, omitted when 0/undefined
  - `learning:true` renders `, learning` suffix
- Use `autoRestoreState()` if any state singletons are mutated; renderer is per-instance and safe to swap via `setRenderer(null)`

### 5. Documentation

- Update [docs/DESIGN.md](docs/DESIGN.md) "UI 设计原则 → Console UI（日志）" — add `[RETRY-n]` to the prefix list with the format example, noting it precedes the final `[ OK ]` / `[FAIL]` line and is emitted by `executeRequestPipeline` for every retry-eligible failure.

## Verification

1. `bun run typecheck` — pass
2. `bun run test:backend` — full backend suite including new tests
3. Manual: trigger a real network reset against a long-running streaming request and confirm a `[RETRY-1]` line appears mid-stream followed by `[ OK ]` (or `[FAIL]`). For 413 path, send an oversized payload to exercise auto-truncate. For deferred-tool path, simulate a tool_use referencing an un-sticky deferred tool.

## Out of scope

- WebSocket / history-UI representation of retries (history already records every attempt via `requestContext.beginAttempt`)
- `action: "abort"` from a strategy that *could have* retried — current behavior treats these as terminal `[FAIL]`, which is correct
- Color/prefix overhaul of `[FAIL]` itself — `[RETRY-n]` slots into existing aesthetic
