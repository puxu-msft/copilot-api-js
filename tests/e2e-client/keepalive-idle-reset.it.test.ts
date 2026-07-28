/**
 * client↔proxy e2e (Anthropic) — keepalive M-2 mechanism, LOCKED as a compressed offline
 * regression test (Tier 1, real undici HTTP client as the oracle — see
 * `.claude/skills/client-proxy-e2e-testing/SKILL.md`).
 *
 * WHAT THIS PROVES: Node's global `fetch` (undici under the hood) applies a per-request
 * body-idle timeout (`bodyTimeout`, production default 300_000ms — see
 * `node_modules/undici/lib/dispatcher/client.js:261`). undici's `client-h1.js` `onBody` handler
 * calls `timeout.refresh()` on EVERY body chunk that arrives after the response headers — so ANY
 * byte (including an empty-delta SSE keepalive chunk) resets the client's idle deadline. This is
 * exactly the mechanism `exp/cc-keepalive-idle-oracle/REPORT.md §0` measured at the REAL 300s
 * scale (armSilent dies at +300.8s, armPing survives past +300s to +320.1s). The reset-on-chunk
 * mechanism is timeout-VALUE-independent: testing it at a COMPRESSED `bodyTimeout` (2.5s) with a
 * proxy-injected keepalive every ~0.5s proves the SAME mechanism that protects production at
 * 300s+. This test drives the REAL proxy in-process (Tier 1 harness, `serveInProcess()`) with a
 * REAL undici `request()` client whose `bodyTimeout` is compressed, mocking only the upstream GHC
 * response body's TIMING (a real `ReadableStream` + real wall-clock `setTimeout`, not fake
 * timers — the client's bodyTimeout is a real OS timer too, so both sides must share real time).
 *
 * TWO ARMS (both load-bearing — armSilent is the positive control, without it armPing's survival
 * proves nothing per the skill's oracle discipline):
 *   - armPing: `streamKeepalivePingSec` small (< bodyTimeout) → the proxy's live-path heartbeat
 *     (`makeAnthropicKeepaliveFrame`, default `empty_text` mode) injects an empty content_block_delta
 *     during the silence → the client's bodyTimeout keeps getting refreshed → SURVIVES past the
 *     compressed deadline and completes with the clean tail.
 *   - armSilent: `streamKeepalivePingSec: 0` → `resolveBufferedAndHeartbeat` (handler-v4.ts) yields
 *     `heartbeatSec <= 0` on the live (non-buffered) path → the sink is built WITHOUT a heartbeat
 *     option (`heartbeatOn` false) → the proxy forwards the upstream's raw silence verbatim → the
 *     client's bodyTimeout fires with ZERO chunks in between → THROWS.
 *
 * NOTE on the "bare SSE comment" claim: a preliminary probe (this task, `exp/tmp-probe/`,
 * discarded after use) empirically found that undici's `onBody` fires — and thus its
 * `bodyTimeout` resets — on ANY received TCP chunk, INCLUDING a bare `: comment\n\n` line; the
 * "ping/comment doesn't count" distinction documented in `exp/cc-idle-280s/REPORT.md` is Claude
 * Code's OWN application-level "no real content chunk" watchdog (a separate, higher-layer
 * counter), not undici's transport-level `bodyTimeout`. This test targets the transport-level
 * mechanism only (per the task scope), so it is agnostic to which keepalive FRAME TYPE the proxy
 * emits — it uses the proxy's real default (`empty_text`), which is also the production default.
 */

import {
  //
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { request } from "undici/index.js"

import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"
import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"

import {
  //
  DONE_FRAME,
  MESSAGE_STOP_FRAME,
  blockStopFrame,
  messageDeltaFrame,
  messageStartFrame,
  textBlockStartFrame,
  textDeltaFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  type InProcessProxy,
  serveInProcess,
} from "./harness/serve-in-process"

const MODEL = "claude-opus-4.8"

/** Compressed undici client-side body-idle deadline (production default is 300_000ms). */
const BODY_TIMEOUT_MS = 2_500
/** Upstream silence duration — comfortably ABOVE bodyTimeout so armSilent must die, and
 *  comfortably above armPing's last-heartbeat-to-tail gap so armPing must survive. */
const SILENCE_MS = 4_500
/** Proxy heartbeat cadence for armPing (seconds) — comfortably BELOW bodyTimeout (2.5s). */
const KEEPALIVE_SEC = 0.5

/**
 * Build an upstream SSE `Response` whose body opens with `preludeChunks`, then goes REAL-CLOCK
 * silent for `delayMs`, then emits `tailChunks` and closes. Real `setTimeout` (not fake timers) —
 * the undici client's `bodyTimeout` is a real timer, so the mock's silence must be real wall-clock
 * time for the mechanism under test to apply.
 */
function delayedSseResponse(preludeChunks: Array<string>, delayMs: number, tailChunks: Array<string>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of preludeChunks) controller.enqueue(encoder.encode(chunk))
      await new Promise<void>((r) => setTimeout(r, delayMs))
      for (const chunk of tailChunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}

/** The generation shape: message_start + an open text block, THEN the caller's silence window,
 *  THEN a text delta + clean terminal sequence. */
function buildGenerationResponse(): Response {
  const prelude = [messageStartFrame({ id: "msg_ka", model: MODEL }), textBlockStartFrame(0)]
  const tail = [textDeltaFrame(0, "done"), blockStopFrame(0), messageDeltaFrame({ stopReason: "end_turn", outputTokens: 5 }), MESSAGE_STOP_FRAME, DONE_FRAME]
  return delayedSseResponse(prelude, SILENCE_MS, tail)
}

/** Drive one streaming /v1/messages request through a REAL undici client with a COMPRESSED
 *  `bodyTimeout`, returning the client-observable outcome (never throws — the caller asserts). */
async function driveCompressedClient(baseURL: string): Promise<{ ok: true; text: string } | { ok: false; error: Error }> {
  try {
    const { body } = await request(`${baseURL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 64, stream: true, messages: [{ role: "user", content: "go" }] }),
      bodyTimeout: BODY_TIMEOUT_MS,
      headersTimeout: 0, // isolate the variable under test — only bodyTimeout may fire
    })
    let text = ""
    for await (const chunk of body) {
      text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
    }
    return { ok: true, text }
  } catch (error) {
    return { ok: false, error: error as Error }
  }
}

describe("client↔proxy e2e (Anthropic) — keepalive M-2: proxy heartbeat resets a REAL undici client's compressed body-idle deadline", () => {
  useIsolatedRuntime()

  let proxy: InProcessProxy

  beforeAll(() => {
    proxy = serveInProcess()
  })
  afterAll(() => proxy.close())

  beforeEach(() => {
    setStateForTests({
      copilotToken: "tok",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0, // disable the proxy's OWN app-level upstream-idle guard (irrelevant here; SILENCE_MS is short)
      streamCommitAfterSec: 20, // large — upstream Response resolves near-instantly → settled-within-window (live) path
      streamKeepaliveMode: "empty_text", // production default — mechanism is frame-type-agnostic (see file header)
    })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })
  afterEach(() => setUpstreamFetchForTests(undefined))

  test("armSilent (positive control): keepalive OFF → the compressed-bodyTimeout client THROWS at the deadline", async () => {
    setStateForTests({ streamKeepalivePingSec: 0 }) // 0 → resolveBufferedAndHeartbeat yields heartbeatSec<=0 → sink built with NO heartbeat timer
    setUpstreamFetchForTests(() => Promise.resolve(buildGenerationResponse()))

    const start = Date.now()
    const result = await driveCompressedClient(proxy.baseURL)
    const elapsedMs = Date.now() - start

    expect(result.ok).toBe(false)
    if (!result.ok) {
      // The REAL undici body-timeout error — UND_ERR_BODY_TIMEOUT / BodyTimeoutError. Asserting the
      // REAL observed error per the oracle discipline (no invented shape).
      expect((result.error as NodeJS.ErrnoException).code).toBe("UND_ERR_BODY_TIMEOUT")
      expect(result.error.message).toContain("Body Timeout")
    }
    // Died at (approximately) the compressed deadline, NOT after the full SILENCE_MS window —
    // proves the deadline is real and would have fired regardless of the eventual tail.
    expect(elapsedMs).toBeGreaterThanOrEqual(BODY_TIMEOUT_MS - 200)
    expect(elapsedMs).toBeLessThan(SILENCE_MS) // must NOT survive to see the tail
  }, 15_000)

  test("armPing (gate): keepalive ON (0.5s < 2.5s bodyTimeout) → the SAME compressed-bodyTimeout client SURVIVES + receives the clean tail", async () => {
    setStateForTests({ streamKeepalivePingSec: KEEPALIVE_SEC })
    setUpstreamFetchForTests(() => Promise.resolve(buildGenerationResponse()))

    const start = Date.now()
    const result = await driveCompressedClient(proxy.baseURL)
    const elapsedMs = Date.now() - start

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toContain("message_stop")
      expect(result.text).toContain('"text_delta"')
      expect(result.text).toContain("done")
      // The heartbeat injected empty content_block_delta frames during the stall (block-aware
      // empty_text mode, index-matched to the open text block@0) — NOT a bare ping — confirming
      // the proxy actually emitted a keepalive (not a false pass from some other survival path).
      expect(result.text).toContain('"text_delta","text":""')
    }
    // Survived PAST the compressed deadline (the naive no-keepalive lifetime) and past the full
    // silence window to receive the real tail.
    expect(elapsedMs).toBeGreaterThanOrEqual(SILENCE_MS - 200)
  }, 15_000)

  test("MUTATION control: with keepalive OFF, a SHORTER silence (below bodyTimeout) still completes cleanly — the armSilent throw above is caused by the SILENCE duration exceeding bodyTimeout, not by some unrelated proxy fault", async () => {
    setStateForTests({ streamKeepalivePingSec: 0 })
    const shortSilenceMs = BODY_TIMEOUT_MS - 1_000 // well under the compressed deadline
    const prelude = [messageStartFrame({ id: "msg_short", model: MODEL }), textBlockStartFrame(0)]
    const tail = [textDeltaFrame(0, "done"), blockStopFrame(0), messageDeltaFrame({ stopReason: "end_turn", outputTokens: 5 }), MESSAGE_STOP_FRAME, DONE_FRAME]
    setUpstreamFetchForTests(() => Promise.resolve(delayedSseResponse(prelude, shortSilenceMs, tail)))

    const result = await driveCompressedClient(proxy.baseURL)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toContain("message_stop")
  }, 15_000)
})
