/**
 * LIVE-PUMP terminal-failure anchor CLOSE-OFF (spec 2026-07-08-buffered-keepalive-empty-text-anchor
 * §10.5 / §10.7 — the whole-branch-review gap I-1). Distinct from
 * `live-post-commit-anchor-closeoff.http.test.ts`: THAT covers the handler pre-pump branches where
 * `await p` itself rejects/reject-routes (upstream never returns headers). THIS covers the case where
 * the upstream RETURNS 200 headers (so `await p` resolves ok → the LIVE pump runs), and the stream
 * THEN errors / truncates BEFORE the first real `content_block_start` arrives.
 *
 * In that window `reconcileLiveFrame` has NOT yet closed the anchor (it only inserts `stop@0` at the
 * first real `content_block_start`), so the synthetic `content_block_start@0` injected during the
 * pre-response stall is still OPEN. `pumpAnthropicStreamingV4`'s terminal error branches
 * (`stream-error`, truncation, unrepairable-tool, catch) must close it off (`content_block_stop@0`,
 * `synthetic:"anchor"`) BEFORE writing the `event: error` frame, or the client is left with a dangling
 * open block followed straight by an error (protocol-incomplete).
 *
 * Deterministic: FakeClock drives the heartbeat cadence; a gated upstream withholds its 200 SSE result
 * until the anchor has been injected during the stall, then delivers a body that fails before any real
 * block. Covers the two pump terminal branches called out by the spec (stream-error + truncation), plus
 * the `enveloped_ping` guard (no anchor block → no stray stop@0).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"

import {
  //
  DONE_FRAME,
  MESSAGE_STOP_FRAME,
  messageDeltaFrame,
  messageStartFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { FakeClock } from "../helpers/fake-clock"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import {
  //
  createSseResponse,
  createSseResponseThenError,
  dataFramesOfType,
  frameTypesInOrder,
} from "../helpers/sse"

const MODEL = "claude-opus-4.8"

/** A terminal upstream `error` SSE event (H2 — e.g. overload) forwarded as a content frame on a clean drain. */
function errorEventFrame(): string {
  return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "overloaded" } })}\n\n`
}

async function drain(n = 120): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe("live PUMP terminal failure — anchor close-off before the error frame (I-1)", () => {
  useIsolatedRuntime()
  const clock = new FakeClock()

  let gateReached: () => void
  let gateReachedP: Promise<void>
  let openGate: () => void
  let gateOpenP: Promise<void>
  // The upstream body the gate delivers once opened (all return 200 headers so `await p` resolves ok →
  // the LIVE pump runs, then fails before the first real content_block_start):
  //   - "stream-error": the SSE body ERRORS mid-stream (H3) before any real block.
  //   - "truncation":   the SSE body closes cleanly WITHOUT message_stop (truncation) before any real block.
  //   - "h2-error":     the SSE body forwards a terminal upstream `error` event (H2) before any real block,
  //                     then closes cleanly — the error frame is the UPSTREAM's own (not a synthetic one), so
  //                     the close-off must precede it at the RECONCILE layer, not the pump terminal branch.
  //   - "zero-content": the SSE body completes SUCCESSFULLY (message_delta + message_stop) with NO content
  //                     block — the reconcile must still close the anchor before the message terminator.
  let bodyMode: "stream-error" | "truncation" | "h2-error" | "zero-content"

  const gatedFetchMock = mock((input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : input.url
    if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL in mock: ${url}`)
    gateReached()
    const messageStart = messageStartFrame({ id: "msg_live", model: MODEL, inputTokens: 7 })
    return gateOpenP.then(() =>
      bodyMode === "stream-error" ?
        // ERROR before any real content block: only the real message_start (dropped by reconcile), then throw.
        createSseResponseThenError([messageStart], new Error("upstream body boom"))
      : bodyMode === "h2-error" ?
        // H2: real message_start + a terminal upstream `error` event, then a clean drain (no message_stop).
        createSseResponse([messageStart, errorEventFrame()])
      : bodyMode === "zero-content" ?
        // Zero-content SUCCESS: message_start + message_delta + message_stop, NO content block.
        createSseResponse([messageStart, messageDeltaFrame({ stopReason: "end_turn", outputTokens: 0 }), MESSAGE_STOP_FRAME, DONE_FRAME])
        // TRUNCATION: real message_start then clean EOF (no content_block_stop, no message_stop).
      : createSseResponse([messageStart]),
    )
  })

  beforeEach(() => {
    clock.install()
    gatedFetchMock.mockClear()
    gateReachedP = new Promise<void>((r) => (gateReached = r))
    gateOpenP = new Promise<void>((r) => (openGate = r))
    bodyMode = "stream-error"
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 2, //   cadence 2s
      streamCommitAfterSec: 2, //     window fires at 2s → commit 200; the anchor injector then fires on the stall
      streamKeepaliveMode: "empty_text",
      protectStreamingGeneration: false, // live path (models the §10.1 live pre-response incident)
    })
    applyFetchMock(gatedFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  afterEach(() => clock.restore())

  async function streamRequest(sessionId: string): Promise<Response> {
    const { createFullTestApp } = await import("../helpers/test-app")
    const app = createFullTestApp()
    return app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
    })
  }

  /** Drive past commit + the stall (so the anchor is injected), then open the gate so the LIVE PUMP fails. */
  async function injectAnchorThenPumpFail(sessionId: string): Promise<string> {
    const resP = streamRequest(sessionId)
    await gateReachedP //           upstream fetch reached (runRequest still pending — gate closed)
    await clock.advance(2_000) //   commit window fires → COMMIT path opens the 200 SSE + starts the callback
    await drain() //                let the callback arm the heartbeat timer + write the cold-start immediate ping
    await clock.advance(2_500) //   the heartbeat cadence now elapses (NO real frame + NO open block) → inject anchor
    await drain() //                let the injector's three sink.writes (message_start + start@0 + delta@0) flush
    const res = await resP
    expect(res.status).toBe(200)
    openGate() //                   upstream now returns 200 headers → `await p` resolves ok → the LIVE pump runs & fails
    // NO extra drain here: `res.text()` awaits the full stream close, which flushes the injected prelude,
    // the pump's close-off, and the error frame in order. An intervening `drain()` would race the
    // fire-and-forget injector chain against the pump's write-out and drop the anchor frames.
    return res.text()
  }

  /** Assert the synthetic anchor prelude was injected AND closed off (stop@0) BEFORE the error frame. */
  function expectAnchorClosedBeforeError(text: string): void {
    const types = frameTypesInOrder(text)

    // The synthetic prelude was injected during the stall (pre-response silence → fabricated message_start + anchor@0).
    expect(types).toContain("message_start")
    const starts = dataFramesOfType(text, "content_block_start")
    expect(starts.some((s) => s.index === 0 && (s.content_block as { type?: string })?.type === "text")).toBe(true)

    // The anchor is closed off with a content_block_stop AT INDEX 0.
    const stops = dataFramesOfType(text, "content_block_stop")
    expect(stops.some((s) => s.index === 0)).toBe(true)

    // Ordering (the whole point): the close-off precedes the terminal error frame — no OPEN block → straight error.
    const idxStop = types.indexOf("content_block_stop")
    const idxError = types.indexOf("error")
    expect(idxStop).toBeGreaterThan(-1)
    expect(idxError).toBeGreaterThan(-1)
    expect(idxError).toBeGreaterThan(idxStop)

    // Exactly ONE close-off at index 0 (the pump's close-off is idempotent — no double stop@0).
    expect(stops.filter((s) => s.index === 0)).toHaveLength(1)
  }

  test("stream-error branch — upstream body errors before the first real block → content_block_stop@0 precedes the error frame", async () => {
    bodyMode = "stream-error"
    const text = await injectAnchorThenPumpFail("live-pump-anchor-stream-error")
    expectAnchorClosedBeforeError(text)
  })

  test("truncation branch — upstream closes without message_stop before any real block → content_block_stop@0 precedes the error frame", async () => {
    bodyMode = "truncation"
    const text = await injectAnchorThenPumpFail("live-pump-anchor-truncation")
    const errors = dataFramesOfType(text, "error")
    expect(errors).toHaveLength(1)
    expect(String((errors[0].error as Record<string, unknown>).message)).toContain("truncated")
    expectAnchorClosedBeforeError(text)
  })

  test("H2 branch — a terminal upstream `error` event before any real block → content_block_stop@0 precedes the forwarded error frame", async () => {
    bodyMode = "h2-error"
    const text = await injectAnchorThenPumpFail("live-pump-anchor-h2")
    // The forwarded error is the UPSTREAM's own overloaded_error (not a synthetic api_error) — proving the
    // close-off is applied at the reconcile layer BEFORE the upstream error frame, not after it.
    const errors = dataFramesOfType(text, "error")
    expect(errors).toHaveLength(1)
    expect((errors[0].error as { type?: string }).type).toBe("overloaded_error")
    expectAnchorClosedBeforeError(text)
  })

  test("enveloped_ping — no anchor block was opened → the guard short-circuits → NO stray content_block_stop@0", async () => {
    setStateForTests({ streamKeepaliveMode: "enveloped_ping" })
    bodyMode = "stream-error"
    const text = await injectAnchorThenPumpFail("live-pump-anchor-enveloped-ping")
    const types = frameTypesInOrder(text)
    // The envelope-only injector forwarded a message_start but reserved NO anchor block → nothing to close off.
    expect(types).toContain("message_start")
    expect(types).toContain("error")
    expect(dataFramesOfType(text, "content_block_stop")).toHaveLength(0)
  })

  test("zero-content SUCCESS — a message terminator before any real block → content_block_stop@0 precedes message_delta, NO error frame", async () => {
    bodyMode = "zero-content"
    const text = await injectAnchorThenPumpFail("live-pump-anchor-zero-content")
    const types = frameTypesInOrder(text)
    // A clean success (no error) — the anchor must still be closed before the message terminator (symmetry
    // with the buffered commit close-off), so the client's block structure is balanced.
    expect(types).not.toContain("error")
    const stops = dataFramesOfType(text, "content_block_stop")
    expect(stops.filter((s) => s.index === 0)).toHaveLength(1) // exactly one close-off at index 0
    const idxStop = types.indexOf("content_block_stop")
    const idxDelta = types.indexOf("message_delta")
    expect(idxStop).toBeGreaterThan(-1)
    expect(idxDelta).toBeGreaterThan(idxStop) // stop@0 precedes the message terminator
    expect(types).toContain("message_stop")
  })
})
