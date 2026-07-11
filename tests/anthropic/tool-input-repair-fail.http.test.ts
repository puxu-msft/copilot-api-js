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
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { RepairItem } from "~/lib/anthropic/tool-input-repair"

import { getToolInputRepairStats } from "~/lib/anthropic/tool-input-repair-stats"
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

function configure(repair: ReadonlyArray<RepairItem>): void {
  setStateForTests({
    copilotToken: "test-token",
    accountType: "individual",
    vsCodeVersion: "1.100.0",
    responseHeaderTimeout: 0,
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
    configure(["tags", "jsonrepair"])
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
    // Data-model: the UPSTREAM leg succeeded (complete 200 stream) — the proxy rejected the
    // malformed content. outboundResponse reflects the upstream leg HONESTLY (success:true, no
    // error); the verdict lives in failureReason (not conflated into the upstream leg's error).
    expect(entry.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
    expect(entry.attempts?.at(-1)?.error).toBeUndefined()
    expect(entry._index?.derived?.failureReason?.toLowerCase()).toContain("unrepairable")
    // richest-data-flow: the accumulated partial is kept, not nulled.
    expect(entry.attempts?.at(-1)?.upstreamResponse?.body).not.toBeNull()
    // The synthetic error frame the client received is recorded in the forwarded (proxy→client) track.
    expect((entry.clientResponse?.sseEvents ?? []).some((e) => e.raw.includes('"type":"error"'))).toBe(true)
    // The raw upstream track is preserved verbatim (original malformed deltas).
    const rawConcat = (entry.attempts?.at(-1)?.upstreamResponse?.sseEvents ?? []).map((e) => e.raw).join("")
    expect(rawConcat).toContain(",,,")
  })

  test("tags mode: a structural break jsonrepair could fix is unrepairable under tags-only → FAILED", async () => {
    // `{...,,,}` is unrepairable under tags too (strip is a no-op on tag-free garbage).
    configure(["tags"])
    frameBuilder = buildUnrepairableComplete
    const sessionId = "unrep-tags"
    const sse = await streamRequest(sessionId)

    expect(dataFramesOfType(sse, "error")).toHaveLength(1)
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry.state).toBe("failed")
  })

  test("precedence: unrepairable AND truncated → fails with the unrepairable reason, not truncation", async () => {
    configure(["tags", "jsonrepair"])
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
    configure(["tags", "jsonrepair"])
    frameBuilder = buildRepairableComplete
    const sessionId = "unrep-repairable-ok"
    const sse = await streamRequest(sessionId)

    expect(dataFramesOfType(sse, "error")).toHaveLength(0)
    expect(dataFramesOfType(sse, "message_stop")).toHaveLength(1)
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry.state).toBe("completed")
    expect(entry.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
  })

  test("repair off (default): malformed input is forwarded as-is, request still completes", async () => {
    configure([])
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
    configure(["tags", "jsonrepair"])
    setStateForTests({ protectStreamingGeneration: "on" })
    frameBuilder = buildUnrepairableComplete
    const sessionId = "unrep-buffered"
    const sse = await streamRequest(sessionId)

    expect(dataFramesOfType(sse, "error")).toHaveLength(1)
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry.state).toBe("failed")
  })

  test("audit C1: a DISCARDED buffered attempt's unrepairable signal must NOT fail the recovered commit", async () => {
    // Attempt 1 emits an unrepairable tool block (sets a per-attempt repair outcome) then truncates
    // (no message_stop) → buffer discarded + retried. Attempt 2 is clean + commits. The request MUST
    // settle `completed`, with NO error frame and an UN-inflated counter — the per-attempt outcomes
    // are cleared in onAttemptReset, so the discarded attempt's signal can't poison the committed one.
    configure(["tags", "jsonrepair"])
    setStateForTests({ protectStreamingGeneration: "on", protectStreamingMaxRetries: 3 })
    let attempt = 0
    frameBuilder = (model: string): Array<string> =>
      attempt++ === 0 ?
        [
          messageStartFrame({ id: "msg_a1", model, inputTokens: 10 }),
          toolBlockStartFrame(0, "toolu_a1", "TodoWrite"),
          jsonDeltaFrame(0, UNREPAIRABLE_INPUT),
          blockStopFrame(0),
          // EOF — no message_stop → truncation → buffered discard + retry.
        ]
      : [
          messageStartFrame({ id: "msg_a2", model, inputTokens: 10 }),
          toolBlockStartFrame(0, "toolu_a2", "TodoWrite"),
          jsonDeltaFrame(0, '{"todos":[]}'),
          blockStopFrame(0),
          messageDeltaFrame({ stopReason: "tool_use", outputTokens: 8 }),
          MESSAGE_STOP_FRAME,
          DONE_FRAME,
        ]
    const sessionId = "c1-recovered"
    const sse = await streamRequest(sessionId)

    expect(dataFramesOfType(sse, "error")).toHaveLength(0)
    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry.state).toBe("completed")
    // The discarded attempt's unrepairable outcome must NOT inflate the per-request counter.
    expect(getToolInputRepairStats().unrepairable).toBe(0)
    expect(attempt).toBeGreaterThanOrEqual(2) // proves a retry actually happened
  })
})

// Repairable only by Layer 2 (jsonrepair) — missing closing brackets, no antml tags.
function buildJsonrepairComplete(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_jr", model, inputTokens: 10 }),
    toolBlockStartFrame(0, "toolu_jr", "TodoWrite"),
    jsonDeltaFrame(0, '{"todos":[1,2,3'),
    blockStopFrame(0),
    messageDeltaFrame({ stopReason: "tool_use", outputTokens: 8 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

// A whitespace-broken `\uXXXX` escape (`\u9 ed8` = 默) — fixed only by the `unicode` item.
function buildBadUnicodeComplete(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_uni", model, inputTokens: 10 }),
    toolBlockStartFrame(0, "toolu_uni", "TodoWrite"),
    jsonDeltaFrame(0, String.raw`{"todos":"\u9 ed8"}`),
    blockStopFrame(0),
    messageDeltaFrame({ stopReason: "tool_use", outputTokens: 8 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

describe("POST /v1/messages — malformed tool-input repair telemetry (P6)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
  })

  test("Layer 1 (strip) repair increments the `strip` counter + logs [REWRITE]", async () => {
    const infoSpy = spyOn(consola, "info").mockImplementation(((..._args: Array<unknown>) => undefined) as unknown as typeof consola.info)
    try {
      configure(["tags"])
      frameBuilder = buildRepairableComplete
      await streamRequest("tele-strip")
      expect(getToolInputRepairStats().strip).toBe(1)
      expect(getToolInputRepairStats().jsonrepair).toBe(0)
      const logged = infoSpy.mock.calls.map((c) => String(c[0]))
      expect(logged.some((m) => m.includes("[REWRITE] tool-input-repair") && m.includes("layer=strip") && m.includes("tool=TodoWrite"))).toBe(true)
    } finally {
      infoSpy.mockRestore()
    }
  })

  test("Layer 2 (jsonrepair) repair increments the `jsonrepair` counter", async () => {
    configure(["tags", "jsonrepair"])
    frameBuilder = buildJsonrepairComplete
    await streamRequest("tele-jsonrepair")
    expect(getToolInputRepairStats().jsonrepair).toBe(1)
    expect(getToolInputRepairStats().strip).toBe(0)
  })

  test("unicode-item repair increments the `unicode` counter + logs [REWRITE]", async () => {
    const infoSpy = spyOn(consola, "info").mockImplementation(((..._args: Array<unknown>) => undefined) as unknown as typeof consola.info)
    try {
      configure(["unicode"])
      frameBuilder = buildBadUnicodeComplete
      await streamRequest("tele-unicode")
      expect(getToolInputRepairStats().unicode).toBe(1)
      expect(getToolInputRepairStats().strip).toBe(0)
      expect(getToolInputRepairStats().jsonrepair).toBe(0)
      const logged = infoSpy.mock.calls.map((c) => String(c[0]))
      expect(logged.some((m) => m.includes("[REWRITE] tool-input-repair") && m.includes("layer=unicode"))).toBe(true)
    } finally {
      infoSpy.mockRestore()
    }
  })

  test("an unrepairable input increments the `unrepairable` counter", async () => {
    configure(["tags", "jsonrepair"])
    frameBuilder = buildUnrepairableComplete
    await streamRequest("tele-unrep")
    expect(getToolInputRepairStats().unrepairable).toBe(1)
  })

  test("repair off: no counter movement (default behavior)", async () => {
    configure([])
    frameBuilder = buildUnrepairableComplete
    await streamRequest("tele-off")
    expect(getToolInputRepairStats()).toEqual({ strip: 0, unicode: 0, jsonrepair: 0, "unicode-lossy": 0, unrepairable: 0 })
  })
})
