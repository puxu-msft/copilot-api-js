/**
 * Phase 3 Task 3.2 — POST-COMMIT canonical error-frame shaping END-TO-END (docs/plan/2026-07-13-upstream-error-client-shaping/phase-3-postcommit-canonical-frame.md).
 *
 * Proves the handler-v4 delayed-commit termini ACTUALLY reach the error-shaping delegation (positive-
 * sample "does the wire touch the target" — the helper's own unit test is byte-precise; this file proves
 * the wiring is live). Four termini + the H2 S5-reshape path, each in disabled (golden verbatim) and
 * enabled (canonical) mode where they diverge:
 *
 *   - ① HTTPError post-commit  — gated fake upstream returns a 401 AFTER the commit window fires
 *       (FakeClock-driven pre-response stall).
 *   - ①' network_error post-commit — immediate-commit (commit=0), then the upstream fetch REJECTS with a
 *       socket-reset Error; the network-retry strategy retries once (real 1s backoff) then propagates to ①'.
 *   - H2 mid-stream event:error — an H2-detected frame (top-level {type:"error"}) with a NON-canonical
 *       inner shape (no inner error.type); enabled = reshaped by the S5 `errorFrameCanonical` rewrite
 *       (adds the canonical api_error type), disabled = forwarded verbatim (no inner type).
 *   - truncation (no message_stop) — always the same canonical frame (byte-identical whether on/off).
 *
 * LOW-1: one-shot tail shaping is independent of the keepalive-mode matrix (that's Phase 6's buffered-
 * replay concern), so the default mode suffices.
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

import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../../helpers/factories"
import { FakeClock } from "../../helpers/fake-clock"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import { applyFetchMock } from "../../helpers/mock-fetch"
import { createSseResponse } from "../../helpers/sse"
import {
  //
  dataFramesOfType,
  frameTypesInOrder,
} from "../../helpers/sse"

const MODEL = "claude-opus-4.8"

async function drain(n = 120): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/** message_start prelude for a streaming fixture. */
function startFrame(model: string, id: string): string {
  return `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`
}
const OPEN_TEXT = `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`
const TEXT_DELTA = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } })}\n\n`

/**
 * An H2-DETECTED upstream error frame (top-level `type:"error"` so the accumulator recognizes it) with a
 * NON-canonical inner shape: no inner `error.type`. Enabled → the S5 rewrite adds the canonical
 * `api_error` type; disabled → forwarded verbatim (still no inner type).
 */
function nonCanonicalH2Frames(model: string): Array<string> {
  return [
    startFrame(model, "msg-h2"),
    OPEN_TEXT,
    TEXT_DELTA,
    `event: error\ndata: ${JSON.stringify({ type: "error", error: { message: "raw upstream boom" } })}\n\n`,
  ]
}

/** A stream that begins then CLEANLY ends WITHOUT message_stop (truncation → terminus ③). */
function truncatedFrames(model: string): Array<string> {
  return [startFrame(model, "msg-trunc"), OPEN_TEXT, TEXT_DELTA]
}

function errorFrame(text: string): { type?: string; message?: string } | undefined {
  return dataFramesOfType(text, "error")[0]?.error as { type?: string; message?: string } | undefined
}

async function streamRequest(sessionId: string): Promise<Response> {
  const { createFullTestApp } = await import("../../helpers/test-app")
  const app = createFullTestApp()
  return app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
  })
}

// ============================================================================
// ① HTTPError post-commit — gated pre-response stall (FakeClock)
// ============================================================================

describe("post-commit shaping ① HTTPError — gated stall (FakeClock)", () => {
  useIsolatedRuntime()
  const clock = new FakeClock()

  let gateReached: () => void
  let gateReachedP: Promise<void>
  let openGate: () => void
  let gateOpenP: Promise<void>

  const gatedFetchMock = mock((input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : input.url
    if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL in mock: ${url}`)
    gateReached()
    return gateOpenP.then(
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "mock 401" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    )
  })

  beforeEach(() => {
    clock.install()
    gatedFetchMock.mockClear()
    gateReachedP = new Promise<void>((r) => (gateReached = r))
    gateOpenP = new Promise<void>((r) => (openGate = r))
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 2,
      streamCommitAfterSec: 2,
      streamKeepaliveMode: "ping",
      protectStreamingGeneration: false,
      errorShapingEnabled: true,
    })
    applyFetchMock(gatedFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  afterEach(() => clock.restore())

  async function commitThenFail(sessionId: string): Promise<string> {
    const resP = streamRequest(sessionId)
    await gateReachedP
    await clock.advance(2_000) // commit window fires → 200 SSE opens
    await drain()
    const res = await resP
    expect(res.status).toBe(200)
    openGate() // upstream now 401s POST-COMMIT
    return res.text()
  }

  test("enabled → canonical event:error frame (authentication_error, reached via decide())", async () => {
    setStateForTests({ errorShapingEnabled: true })
    const text = await commitThenFail("postcommit-http-enabled")
    expect(frameTypesInOrder(text)).toContain("error")
    expect(errorFrame(text)?.type).toBe("authentication_error")
  })

  test("DISABLED → golden verbatim legacy frame (byte-identical to anthropicHttpErrorFrame)", async () => {
    setStateForTests({ errorShapingEnabled: false })
    const { anthropicHttpErrorFrame } = await import("../../../src/routes/messages/post-commit-error")
    const { HTTPError } = await import("~/lib/error")
    const expected = anthropicHttpErrorFrame(
      new HTTPError("mock", 401, JSON.stringify({ type: "error", error: { type: "authentication_error", message: "mock 401" } })),
    )
    const text = await commitThenFail("postcommit-http-disabled")
    // The disabled path returns the legacy frame verbatim; its data matches the legacy builder byte-for-byte.
    expect(JSON.stringify(dataFramesOfType(text, "error")[0])).toBe(expected.data ?? "")
  })
})

// ============================================================================
// ①' network_error + H2 reshape + truncation — immediate commit (real timers)
// ============================================================================

describe("post-commit shaping ①'/H2/truncation — immediate commit (real timers)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 0,
      streamCommitAfterSec: 0, // immediate commit (200 SSE opens before the upstream resolves)
      protectStreamingGeneration: false,
      errorShapingEnabled: true,
    })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("①' network_error post-commit, enabled → canonical api_error frame (decide() reached — the ONLY post-commit network_error path)", async () => {
    setStateForTests({ errorShapingEnabled: true })
    applyFetchMock(mock(() => Promise.reject(new Error("socket hang up ECONNRESET"))))
    const text = await (await streamRequest("postcommit-net-enabled")).text()
    expect(errorFrame(text)?.type).toBe("api_error")
    expect(errorFrame(text)?.message).toContain("socket hang up")
  }, 15_000)

  test("①' network_error post-commit, DISABLED → golden verbatim api_error frame", async () => {
    setStateForTests({ errorShapingEnabled: false })
    applyFetchMock(mock(() => Promise.reject(new Error("socket hang up ECONNRESET"))))
    const text = await (await streamRequest("postcommit-net-disabled")).text()
    expect(errorFrame(text)?.type).toBe("api_error")
    expect(errorFrame(text)?.message).toContain("socket hang up")
  }, 15_000)

  test("H2 non-canonical event:error (H2-detected, no inner type), enabled → S5 reshapes into a canonical envelope (adds api_error type), single error frame", async () => {
    setStateForTests({ errorShapingEnabled: true })
    applyFetchMock(mock(() => Promise.resolve(createSseResponse(nonCanonicalH2Frames(MODEL)))))
    const text = await (await streamRequest("h2-enabled")).text()
    // Exactly one error frame (H2-detected → no truncation double-emit), reshaped to carry api_error.
    expect(text.match(/"type":"error"/g)?.length).toBe(1)
    expect(errorFrame(text)?.type).toBe("api_error")
    expect(errorFrame(text)?.message).toBe("raw upstream boom")
  })

  test("H2 non-canonical event:error, DISABLED → forwarded VERBATIM (no S5 reshape, no inner type)", async () => {
    setStateForTests({ errorShapingEnabled: false })
    applyFetchMock(mock(() => Promise.resolve(createSseResponse(nonCanonicalH2Frames(MODEL)))))
    const text = await (await streamRequest("h2-disabled")).text()
    expect(text.match(/"type":"error"/g)?.length).toBe(1)
    // Verbatim: the frame reached the client with NO inner error.type (unshaped).
    expect(errorFrame(text)?.type).toBeUndefined()
    expect(errorFrame(text)?.message).toBe("raw upstream boom")
  })

  test.each([true, false])("truncation (no message_stop), errorShapingEnabled=%p → canonical api_error truncation frame", async (enabled) => {
    setStateForTests({ errorShapingEnabled: enabled })
    applyFetchMock(mock(() => Promise.resolve(createSseResponse(truncatedFrames(MODEL)))))
    const text = await (await streamRequest(`trunc-${enabled}`)).text()
    expect(errorFrame(text)?.type).toBe("api_error")
    expect(errorFrame(text)?.message).toBe("Upstream stream truncated before completion (no message_stop)")
  })
})
