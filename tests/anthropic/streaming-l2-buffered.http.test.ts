/**
 * L2 (streaming buffered retry) — Phase 2 handler wiring, http end-to-end.
 *
 * With `anthropic.protect_streaming_generation` ENABLED, the Anthropic `/v1/messages`
 * pump selects `driver.runResponseBufferedSink`: it buffers the whole generation and,
 * when the upstream RSTs mid-stream (transport-close), discards the buffer + re-exchanges,
 * transparently delivering ONE complete generation to the client. Asserts:
 *   1. front N attempts RST, then complete → the client receives the COMPLETE generation
 *      (message_stop + intact tool_use), NO partial/error frames, history `completed`.
 *   2. the per-attempt accumulator is fully reset between attempts — usage is NOT summed
 *      across the failed attempts (the §14 [MEDIUM] acc-reset fix; a leak would double
 *      input_tokens/output_tokens), and `attemptCount` counts every exchange.
 *   3. retries exhausted (every attempt RSTs) → falls back to the live failure shape
 *      (synthetic error frame, NO message_stop, history `failed`).
 *
 * The DEFAULT-OFF byte regression lives in streaming-l2-baseline.http.test.ts (untouched
 * by this file). See docs/rfc/streaming-upstream-rst-buffered-retry.md §11 Phase 2 / §14.
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

import { getProtectStreamingStats } from "~/lib/anthropic/protect-streaming-stats"
import { getHistory } from "~/lib/history/store"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"
import {
  //
  createSseResponse,
  createSseResponseThenError,
} from "../helpers/sse"

const MODEL = "claude-opus-4.8"

/** Complete generation: text + a Write tool_use + terminal sequence (input_tokens 100, output_tokens 20). */
function buildCompleteFrames(model: string): Array<string> {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_buf", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Writing." } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_buf", name: "Write", input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path": "/tmp/x.md", "content": "# hi"}' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

/** Up to (and including) a partial tool_use, then the upstream stream ERRORS (RST). */
function buildPartialFrames(model: string): Array<string> {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_bufr", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_bufr", name: "Write", input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path": "/tmp/big.md", "content": "# partial' } })}\n\n`,
  ]
}

const RST_ERROR = new Error("Stream closed with error code NGHTTP2_CANCEL")

/** Number of leading upstream attempts that RST before the upstream finally completes. */
let rstBeforeComplete = 0
/** When true, EVERY attempt RSTs (retries exhausted scenario). */
let alwaysRst = false
let upstreamCalls = 0
/** Captured upstream wire bodies (parsed) per exchange — for asserting per-retry escalation. */
const capturedBodies: Array<Record<string, unknown>> = []

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  const model = payload.model ?? MODEL
  if (url.endsWith("/v1/messages")) {
    if (typeof init?.body === "string") capturedBodies.push(JSON.parse(init.body) as Record<string, unknown>)
    upstreamCalls += 1
    const rst = alwaysRst || upstreamCalls <= rstBeforeComplete
    return Promise.resolve(rst ? createSseResponseThenError(buildPartialFrames(model), RST_ERROR) : createSseResponse(buildCompleteFrames(model)))
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function streamRequest(sessionId: string): Promise<string> {
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "write a file" }],
      max_tokens: 256,
      stream: true,
      tools: [{ name: "Write", description: "write a file", input_schema: { type: "object", properties: {} } }],
    }),
  })
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  return res.text()
}

function frameTypesInOrder(sse: string): Array<string> {
  const out: Array<string> = []
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const body = line.slice(6)
    if (body === "[DONE]") {
      out.push("[DONE]")
      continue
    }
    try {
      out.push((JSON.parse(body) as { type?: string }).type ?? "?")
    } catch {
      /* keepalive/non-json */
    }
  }
  return out
}

describe("L2 buffered retry — Anthropic streaming handler wiring (protect_streaming_generation=on)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    upstreamCalls = 0
    rstBeforeComplete = 0
    alwaysRst = false
    capturedBodies.length = 0
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
      streamIdleTimeout: 0,
      staleRequestMaxAge: 0,
      anthropicFakeSseHeartbeat: 0,
      protectStreamingGeneration: "on",
      protectStreamingMaxRetries: 3,
      protectStreamingHeartbeat: 15,
    })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("2 mid-stream RSTs then complete → client transparently receives ONE complete generation, history completed", async () => {
    rstBeforeComplete = 2
    const sse = await streamRequest("l2-buf-retry")

    // The client sees ONLY the final complete generation — no leaked partial, no error frame.
    expect(frameTypesInOrder(sse)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(frameTypesInOrder(sse)).not.toContain("error")

    // The COMPLETE Write tool_use input (not the RST'd partial) is what the client receives.
    const toolDelta = sse
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => {
        try {
          return JSON.parse(l.slice(6)) as { type?: string; index?: number; delta?: { type?: string; partial_json?: string } }
        } catch {
          return undefined
        }
      })
      .find((o) => o?.type === "content_block_delta" && o.delta?.type === "input_json_delta")
    expect(toolDelta?.delta?.partial_json).toBe('{"file_path": "/tmp/x.md", "content": "# hi"}')

    // 3 upstream exchanges (2 RST + 1 complete).
    expect(upstreamCalls).toBe(3)

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "l2-buf-retry", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    expect(entry?.outboundResponse?.success).toBe(true)
    // The accumulator was reset per attempt — usage reflects ONE generation, not the sum of 3.
    expect(entry?.outboundResponse?.usage?.input_tokens).toBe(100)
    expect(entry?.outboundResponse?.usage?.output_tokens).toBe(20)
    // Every exchange is recorded as an attempt.
    expect(entry?.attemptCount).toBe(3)
    // D1: each FAILED (non-final) attempt keeps its own upstream-original frames for diagnosis;
    // the SUCCESSFUL (final) attempt's frames are the top-level mirror, not duplicated per-attempt.
    expect(entry?.attempts?.[0]?.sseEvents?.length).toBeGreaterThan(0)
    expect(entry?.attempts?.[1]?.sseEvents?.length).toBeGreaterThan(0)
    expect(entry?.attempts?.[2]?.sseEvents).toBeUndefined()
    // Hit-rate telemetry: one save after 2 retries (RFC §10).
    expect(getProtectStreamingStats()).toEqual({ success: 1, exhausted: 0, retreated: 0, totalRetries: 2 })
  })

  test("acc reset regression — even 3 leading RSTs commit a single non-summed generation", async () => {
    rstBeforeComplete = 3
    const sse = await streamRequest("l2-buf-reset")

    expect(frameTypesInOrder(sse)).toContain("message_stop")
    expect(frameTypesInOrder(sse)).not.toContain("error")
    expect(upstreamCalls).toBe(4)

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "l2-buf-reset", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    // A leak (failed-attempt frames folded into the final acc) would inflate these past one generation.
    expect(entry?.outboundResponse?.usage?.input_tokens).toBe(100)
    expect(entry?.outboundResponse?.usage?.output_tokens).toBe(20)
    expect(entry?.attemptCount).toBe(4)
  })

  test("retries exhausted (every attempt RSTs) → synthetic error, NO message_stop, history failed", async () => {
    alwaysRst = true
    const sse = await streamRequest("l2-buf-exhaust")

    const types = frameTypesInOrder(sse)
    // All-or-nothing: nothing was committed, so the client gets ZERO content frames — only
    // the synthetic terminator (the buffered path never live-forwards partials).
    expect(types).toContain("error")
    expect(types).not.toContain("message_stop")
    expect(types).not.toContain("content_block_delta")

    // 1 original + protect_streaming_max_retries (3) re-exchanges = 4 attempts.
    expect(upstreamCalls).toBe(4)

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "l2-buf-exhaust", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
    expect(entry?.outboundResponse?.success).toBe(false)
  })

  test("buffer cap (tiny) → retreat to live, client still gets the full generation, history completed", async () => {
    rstBeforeComplete = 0 // a clean complete stream; the cap forces a retreat, not a retry
    setStateForTests({ protectStreamingBufferCapBytes: 10 }) // 10 bytes → exceeded almost immediately
    const sse = await streamRequest("l2-buf-cap")

    // Retreat forwards the whole generation live (the cap only forfeits buffering, not delivery).
    expect(frameTypesInOrder(sse)).toContain("message_stop")
    expect(frameTypesInOrder(sse)).not.toContain("error")
    expect(upstreamCalls).toBe(1) // no retry

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "l2-buf-cap", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    expect(entry?.outboundResponse?.success).toBe(true)
  })

  test("escalation ON → each retry's wire forces a progressively aggressive context_management", async () => {
    // opus-4.8 is NOT in modelSupportsContextEditing, so escalation would be a no-op there; use a
    // supported model (opus-4-6) to prove the handler→driver→prepareWire threading injects it.
    const SUPPORTED = "claude-opus-4-6"
    setModels({ object: "list", data: [mockModel(SUPPORTED, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
    setStateForTests({ protectStreamingEscalateContext: true })
    rstBeforeComplete = 1 // attempt 0 RSTs, attempt 1 (retry) escalates + completes

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "l2-buf-esc" },
      body: JSON.stringify({
        model: SUPPORTED,
        messages: [{ role: "user", content: "write" }],
        max_tokens: 256,
        stream: true,
        tools: [{ name: "Write", description: "w", input_schema: { type: "object", properties: {} } }],
      }),
    })
    expect(res.status).toBe(200)
    await res.text()

    expect(upstreamCalls).toBe(2)
    // Attempt 0 (no escalation) has no forced context_management (context_editing is off by default).
    expect(capturedBodies[0]?.context_management).toBeUndefined()
    // Attempt 1 (first retry) carries an aggressive clear_tool_uses: trigger halved (100000→50000), keep 3→2.
    expect(capturedBodies[1]?.context_management).toEqual({
      edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 50000 }, keep: { type: "tool_uses", value: 2 } }],
    })
  })
})

// ============================================================================
// Forced heartbeat during the buffer window (RFC §5 / §14 🔴)
// ============================================================================

/** Minimal deterministic clock (mirrors fake-sse-heartbeat.unit.test). Only the heartbeat timer matters here. */
class FakeClock {
  now = 1_000_000
  private nextId = 1
  private timers = new Map<number, { fireAt: number; cb: () => void; cleared?: boolean }>()
  private origSet = globalThis.setTimeout
  private origClear = globalThis.clearTimeout
  private origNow = Date.now
  install(): void {
    Date.now = () => this.now
    ;(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((cb: () => void, ms: number) => {
      const id = this.nextId++
      this.timers.set(id, { fireAt: this.now + ms, cb })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    ;(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      const e = this.timers.get(id as unknown as number)
      if (e) e.cleared = true
    }) as typeof clearTimeout
  }
  restore(): void {
    Date.now = this.origNow
    globalThis.setTimeout = this.origSet
    globalThis.clearTimeout = this.origClear
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => !t.cleared && t.fireAt <= target).sort(([, a], [, b]) => a.fireAt - b.fireAt)
      if (due.length === 0) break
      const [id, entry] = due[0]
      this.now = entry.fireAt
      this.timers.delete(id)
      entry.cb()
      await Promise.resolve()
      await Promise.resolve()
    }
    this.now = target
  }
}

describe("L2 buffered retry — forced heartbeat during the buffer window (anthropicFakeSseHeartbeat=0)", () => {
  useIsolatedRuntime()
  const clock = new FakeClock()

  // A complete upstream that emits message_start, then BLOCKS on a gate before the rest —
  // so the buffer window stays open while we advance the clock past the heartbeat interval.
  let gateReached: () => void
  let gateReachedP: Promise<void>
  let openGate: () => void
  let gateOpenP: Promise<void>

  function gatedCompleteResponse(model: string): Response {
    const frames = buildCompleteFrames(model)
    const encoder = new TextEncoder()
    let i = 0
    const stream = new ReadableStream({
      async pull(controller) {
        if (i === 0) {
          controller.enqueue(encoder.encode(frames[i]))
          i += 1
          return
        }
        if (i === 1) {
          gateReached()
          await gateOpenP
        }
        if (i < frames.length) {
          controller.enqueue(encoder.encode(frames[i]))
          i += 1
        } else {
          controller.close()
        }
      },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
  }

  const gatedFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : input.url
    const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
    if (url.endsWith("/v1/messages")) return Promise.resolve(gatedCompleteResponse(payload.model ?? MODEL))
    throw new Error(`unexpected upstream URL in mock: ${url}`)
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
      fetchTimeout: 0,
      streamIdleTimeout: 0,
      staleRequestMaxAge: 0,
      // User did NOT configure a heartbeat — the buffered path must FORCE one from protect_streaming_heartbeat.
      anthropicFakeSseHeartbeat: 0,
      protectStreamingGeneration: "on",
      protectStreamingMaxRetries: 3,
      protectStreamingHeartbeat: 10,
    })
    applyFetchMock(gatedFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  afterEach(() => clock.restore())

  test("buffered path injects a ping while buffering, then commits the complete generation", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "l2-buf-hb" },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "write a file" }],
        max_tokens: 256,
        stream: true,
        tools: [{ name: "Write", description: "write a file", input_schema: { type: "object", properties: {} } }],
      }),
    })
    expect(res.status).toBe(200)
    const textP = res.text()

    // Wait until the handler is mid-buffer (message_start consumed, blocked on the gate),
    // then advance past the forced heartbeat interval (10s) → a ping must fire on the wire.
    await gateReachedP
    await clock.advance(10_000 + 100)
    // Release the upstream so it completes + the buffer commits.
    openGate()
    const sse = await textP

    const types = frameTypesInOrder(sse)
    // The forced heartbeat reached the client DURING the buffer window (kept it alive)…
    expect(types).toContain("ping")
    // …and the complete generation was committed afterward (all-or-nothing, transparent).
    expect(types).toContain("message_stop")
    expect(types).not.toContain("error")

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "l2-buf-hb", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
  })
})
