# `~/lib/pipeline/hooks` — hook author reference

This package is the upstream hook middleware's public surface: an `UpstreamHook` module (loaded
from a user-configured file path) can export `onRequest` / `onExchange` / `rewriteUpstreamFrame`,
and `~/lib/pipeline/hooks` (this barrel) is everything such a module imports to mock upstream,
inject faults, and replay recorded history. Full design: `docs/spec/2026-07-12-upstream-hook-middleware.md`.

## Toolkit (`toolkit.ts`)

| Helper | Purpose |
|---|---|
| `sse(event, dataObj)` | Build one `UpstreamFrame` — JSON-encodes `dataObj` unless it's already a string (so `"[DONE]"` passes through verbatim). |
| `streamOf(frames, headers?)` | Wrap frames into an `UpstreamStream` tagged `"hook-mock"`. |
| `mockAnthropicMessage(text)` / `mockCcChunks(text)` / `mockGeminiResponse(text)` | Build a complete, wire-valid SSE sequence for one text reply in the given format. |
| `mockUpstreamError(status, body?)` | Throw a real `HTTPError` (never a plain `Error`) with `body` serialized into `responseText`. |
| `mockUpstreamError.toolFieldRejection()` / `.serverToolRejection()` / `.cacheControlSubfield()` / `.unsupportedBeta()` | Ready-made presets, each hitting one of the driver's 4 reactive-rejection retry strategies. |
| `replayFromHistory(selector)` | Rebuild an `UpstreamStream` from a recorded history entry's last attempt (`selector`: a request id, or `{model?, endpoint?, latest?}` filters — always the latest match). Tagged `"hook-replay"`. |
| `delay(ms)` | Curried latency injector: `delay(ms)(value)` awaits `ms` then resolves to `value`. |
| `truncateAfter(n, stream)` | Cut a stream off after its first `n` frames — simulates an abruptly dropped upstream connection. |

## Two warnings every hook author must know

### 1. `onExchange` is called **L1 × L2** times per client request, not once

`onExchange` is mounted **inside the driver's retry loop**, not at a one-shot request boundary.
The actual call count for a single client request is **L1 attempts × L2 buffered-retry
re-exchanges** (`runExchange` has two call sites in `driver.ts`: the main `runRequest` loop and the
buffered-retry sink). This is harmless for a hook that always returns the same fixed mock — but a
**stateful** hook (one that counts calls, mutates captured state, or drives a record/replay
sequence) MUST account for being invoked multiple times within what looks like a single logical
request. If your hook needs "only mock the first attempt" or "only the final settle" semantics,
track that explicitly (e.g. a counter closed over in the hook module) rather than assuming
one-call-per-request.

### 2. A mock stream that never calls `next()` bypasses the transport's guards

`onExchange`'s `next()` calls into the real `Transport.send`, which is where `guardSseIterable`
(the idle-timeout / shutdown / client-abort guard) and the adaptive rate-limiter live. A hook that
returns `streamOf(...)` / `mockAnthropicMessage(...)` / any other mock **without calling `next()`**
skips both — by design (a mock has no real upstream to guard), but it means:

- **Timeout/idle-abort behavior cannot be exercised through a mock stream.** If you need to test
  what happens when the upstream goes silent or the client disconnects mid-stream, you must
  construct the raw frames/timing yourself (e.g. `delay` + `truncateAfter` combinations) rather
  than relying on the guard to kick in — the guard simply isn't in the path for a hook-mocked
  exchange.
- **Rate-limiting is not applied to mock traffic.** A load-test hook that returns mocks in a tight
  loop will not be throttled the way a real upstream call would be.

## Independent-oracle testing convention

Every format mock (`mockAnthropicMessage`/`mockCcChunks`/`mockGeminiResponse`) is verified in
`tests/pipeline/hooks/toolkit.unit.test.ts` by feeding its frames through the SAME production
stream accumulator/translator the driver uses to decode a genuine upstream response — never by
asserting a mock against its own hand-rolled logic. `mockUpstreamError`'s 4 presets are verified
against the EXACT regex/pattern constant each real reactive-retry strategy module exports (not a
hand-copied duplicate), so the mock and the strategy it targets can never silently drift apart.
