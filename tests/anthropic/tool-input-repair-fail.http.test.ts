/**
 * P4 — end-to-end fail channel for an UNREPAIRABLE malformed tool_use input.
 *
 * When `anthropic.tool_repair_malformed_input` is on and a `tool_use` input
 * survives both repair layers still malformed, the proxy must NOT forward a
 * silently-broken tool call as a success: the decoder reports `input-unrepairable`
 * → the S5 closure flags the ctx → the handler's complete-branch settles the
 * request FAILED, preserves the partial (richest-data-flow), and emits a synthetic
 * Anthropic `error` frame. History keeps the upstream-original sseEvents.
 *
 * Also locks the precedence: an unrepairable block that is ALSO truncated (no
 * message_stop) fails with the unrepairable reason, not the truncation reason.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history/store"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import {
  //
  DONE_FRAME,
  MESSAGE_STOP_FRAME,
  blockStopFrame,
  jsonDeltaFrame,
  messageDeltaFrame,
  messageStartFrame,
  toolBlockStartFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"
import {
  //
  createSseResponse,
  dataFramesOfType,
} from "../helpers/sse"

const MODEL = "claude-opus-4.8"

// jsonrepair throws on the excess-comma garbage `{...,,,}`, and antml-strip is a
// no-op (no tags) → unrepairable under BOTH "tags" and "repair" modes.
const UNREPAIRABLE_INPUT = '{"todos":1,,,}'

// A complete stream whose single tool_use carries unrepairable input JSON.
function buildUnrepairableComplete(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_unrep", model, inputTokens: 10 }),
    toolBlockStartFrame(0, "toolu_unrep", "TodoWrite"),
    jsonDeltaFrame(0, UNREPAIRABLE_INPUT),
    blockStopFrame(0),
    messageDeltaFrame({ stopReason: "tool_use", outputTokens: 8 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

// Unrepairable AND truncated (no message_stop) — exercises the precedence gate.
function buildUnrepairableTruncated(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_unrep_trunc", model, inputTokens: 10 }),
    toolBlockStartFrame(0, "toolu_unrep", "TodoWrite"),
    jsonDeltaFrame(0, UNREPAIRABLE_INPUT),
    blockStopFrame(0),
    // EOF — no message_delta / message_stop.
  ]
}

// A repairable antml-bleed (Layer 1 strip fixes it) — must still SUCCEED.
function buildRepairableComplete(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_ok", model, inputTokens: 10 }),
    toolBlockStartFrame(0, "toolu_ok", "TodoWrite"),
    jsonDeltaFrame(0, '{"todos":[{"content":"x","status":"pending","activeForm":"y"}]</parameter></invoke>}'),
    blockStopFrame(0),
    messageDeltaFrame({ stopReason: "tool_use", outputTokens: 8 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

let frameBuilder: (model: string) => Array<string> = buildUnrepairableComplete

const upstreamFetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  if (url.endsWith("/v1/messages")) return createSseResponse(frameBuilder(payload.model ?? MODEL))
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function streamRequest(sessionId: string): Promise<string> {
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
  })
  expect(res.status).toBe(200)
  return res.text()
}

function configure(repair: "tags" | "repair" | false): void {
  setStateForTests({
    copilotToken: "test-token",
    accountType: "individual",
    vsCodeVersion: "1.100.0",
    fetchTimeout: 0,
    streamIdleTimeout: 0,
    streamKeepalivePingSec: 0,
    toolRepairMalformedInput: repair,
  })
  applyFetchMock(upstreamFetchMock)
  setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
}

describe("POST /v1/messages — unrepairable malformed tool-input fail channel (P4)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    frameBuilder = buildUnrepairableComplete
  })

  test("repair mode: unrepairable input → synthetic error frame + FAILED history + partial preserved", async () => {
    configure("repair")
    frameBuilder = buildUnrepairableComplete
    const sessionId = "unrep-repair"
    const sse = await streamRequest(sessionId)

    // A synthetic Anthropic `error` event signals the broken tool call to the client.
    const errors = dataFramesOfType(sse, "error")
    expect(errors).toHaveLength(1)
    expect(String((errors[0].error as Record<string, unknown>).message).toLowerCase()).toContain("malformed")

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry).toBeDefined()
    expect(entry.state).toBe("failed")
    expect(entry.outboundResponse?.success).toBe(false)
    // richest-data-flow: the accumulated partial is kept, not nulled.
    expect(entry.outboundResponse?.content).not.toBeNull()
    // The raw upstream track is preserved verbatim (original malformed deltas).
    const rawConcat = (entry.sseEvents ?? []).map((e) => e.raw).join("")
    expect(rawConcat).toContain(",,,")
  })

  test("tags mode: a structural break jsonrepair could fix is unrepairable under tags-only → FAILED", async () => {
    // `{...,,,}` is unrepairable under tags too (strip is a no-op on tag-free garbage).
    configure("tags")
    frameBuilder = buildUnrepairableComplete
    const sessionId = "unrep-tags"
    const sse = await streamRequest(sessionId)

    expect(dataFramesOfType(sse, "error")).toHaveLength(1)
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry.state).toBe("failed")
  })

  test("precedence: unrepairable AND truncated → fails with the unrepairable reason, not truncation", async () => {
    configure("repair")
    frameBuilder = buildUnrepairableTruncated
    const sessionId = "unrep-trunc"
    const sse = await streamRequest(sessionId)

    const errors = dataFramesOfType(sse, "error")
    expect(errors).toHaveLength(1)
    // The more precise root cause wins over the missing-message_stop truncation message.
    const msg = String((errors[0].error as Record<string, unknown>).message).toLowerCase()
    expect(msg).toContain("malformed")
    expect(msg).not.toContain("truncated")

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry.state).toBe("failed")
  })

  test("regression: a repairable antml-bleed still SUCCEEDS (no error frame, completed)", async () => {
    configure("repair")
    frameBuilder = buildRepairableComplete
    const sessionId = "unrep-repairable-ok"
    const sse = await streamRequest(sessionId)

    expect(dataFramesOfType(sse, "error")).toHaveLength(0)
    expect(dataFramesOfType(sse, "message_stop")).toHaveLength(1)
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry.state).toBe("completed")
    expect(entry.outboundResponse?.success).toBe(true)
  })

  test("repair off (default): malformed input is forwarded as-is, request still completes", async () => {
    configure(false)
    frameBuilder = buildUnrepairableComplete
    const sessionId = "unrep-off"
    const sse = await streamRequest(sessionId)

    // Off = pre-repair behavior: no fail-gate, the malformed bytes pass through, message completes.
    expect(dataFramesOfType(sse, "error")).toHaveLength(0)
    expect(dataFramesOfType(sse, "message_stop")).toHaveLength(1)
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry.state).toBe("completed")
  })

  test("L2 buffered path: the unrepairable signal rides the ctx and survives the buffered flush (not acc)", async () => {
    // protect_streaming_generation buffers the whole response and resets the upstream-side
    // accumulators via onAttemptReset. The fail flag lives on the ctx (not acc), so the
    // complete-branch still fails. If the flag were (wrongly) acc-hung, the buffered reset
    // would drop it and this would settle `completed` → RED.
    configure("repair")
    setStateForTests({ protectStreamingGeneration: "on" })
    frameBuilder = buildUnrepairableComplete
    const sessionId = "unrep-buffered"
    const sse = await streamRequest(sessionId)

    expect(dataFramesOfType(sse, "error")).toHaveLength(1)
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry.state).toBe("failed")
  })
})
