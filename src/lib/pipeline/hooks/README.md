# `~/lib/pipeline/hooks` — hook author reference

This package is the symmetric four-point hook middleware's public surface (RFC
`docs/rfc/2026-07-14-symmetric-four-point-hooks.md`). A hook module (loaded from a user-configured
file path) exports a single `export const hooks = { ... }` object, grouped by two axes:

```ts
export const hooks = {
  upstream: {
    inbound: (frame, env) => frame,   // per upstream response frame (rewrite / drop via undefined)
    outbound: (env) => env,           // upstream-bound request, one-shot (post-sanitize/pre-exchange)
  },
  exchange: async (wire, env, next) => next(),  // wrap the whole upstream call (mock / fault / replay)
}
```

`client.inbound` (client-native request rewrite, one-shot before translate/sanitize) lands in RFC
Phase 4; `client.outbound` (per-client-frame response rewrite) is named but wiring is gated on
sink-egress unification (RFC Phase 6). Any leaf may be omitted (= that boundary passes through);
a rewrite returning `undefined` = observe (pass through after side effects). `~/lib/pipeline/hooks`
(this barrel) is everything such a module imports to mock upstream, inject faults, and replay
recorded history. Full design: `docs/spec/2026-07-12-upstream-hook-middleware.md`.

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

### 1. `exchange` is called **L1 × L2** times per client request, not once

`exchange` is mounted **inside the driver's retry loop**, not at a one-shot request boundary.
The actual call count for a single client request is **L1 attempts × L2 buffered-retry
re-exchanges** (`runExchange` has two call sites in `driver.ts`: the main `runRequest` loop and the
buffered-retry sink). This is harmless for a hook that always returns the same fixed mock — but a
**stateful** hook (one that counts calls, mutates captured state, or drives a record/replay
sequence) MUST account for being invoked multiple times within what looks like a single logical
request. If your hook needs "only mock the first attempt" or "only the final settle" semantics,
track that explicitly (e.g. a counter closed over in the hook module) rather than assuming
one-call-per-request. (By contrast `upstream.outbound` and, in Phase 4, `client.inbound` are
one-shot — invoked exactly once per logical request; `upstream.inbound` is per upstream frame.)

### 2. A mock stream that never calls `next()` bypasses the transport's guards

`exchange`'s `next()` calls into the real `Transport.send`, which is where `guardSseIterable`
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
