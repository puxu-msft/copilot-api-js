/**
 * End-to-end test for upstream stream truncation detection on /v1/messages.
 *
 * Reproduces the real bug (req_1782109585894_535): GHC streams a partial tool_use
 * (message_start + content_block_start + input_json_deltas) then cleanly closes the
 * h2 stream WITHOUT the mandatory `message_stop` terminator. The proxy must NOT
 * mis-classify this clean EOF as success — it settles the entry as FAILED (so the
 * proxy log is no longer a silent `[ OK ]`), preserves the accumulated partial on
 * the entry (richest-data-flow), and emits a synthetic Anthropic `error` event so
 * the client SDK gets a clean terminator instead of a dangling, unterminated stream.
 *
 * See docs/rfc/upstream-stream-truncation-detection.md.
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

// Truncated upstream: a partial tool_use, then EOF. NO content_block_stop, NO
// message_delta, NO message_stop, NO [DONE] — exactly the real GHC mid-stream cutoff.
function buildTruncatedFrames(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_trunc", model, inputTokens: 10 }),
    toolBlockStartFrame(0, "toolu_trunc", "Agent"),
    jsonDeltaFrame(0, '{"description": "x", "subagent'),
    // EOF here — the ReadableStream closes with no protocol terminator.
  ]
}

// Complete upstream (regression baseline): same shape WITH the terminal sequence.
function buildCompleteFrames(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_ok", model, inputTokens: 10 }),
    toolBlockStartFrame(0, "toolu_ok", "Agent"),
    jsonDeltaFrame(0, '{"description": "x", "subagent_type": "general-purpose"}'),
    blockStopFrame(0),
    messageDeltaFrame({ stopReason: "tool_use", outputTokens: 8 }),
    MESSAGE_STOP_FRAME,
    DONE_FRAME,
  ]
}

let frameBuilder: (model: string) => Array<string> = buildTruncatedFrames

const upstreamFetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  if (url.endsWith("/v1/messages")) {
    return createSseResponse(frameBuilder(payload.model ?? MODEL))
  }
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
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  return res.text()
}

describe("POST /v1/messages — upstream stream truncation detection", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    frameBuilder = buildTruncatedFrames
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 0,
    })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("truncated stream → client receives the partial frames AND a synthetic error event", async () => {
    frameBuilder = buildTruncatedFrames
    const sse = await streamRequest("trunc-client-error")

    // The partial content the upstream did send is still forwarded (streaming can't unsend).
    expect(dataFramesOfType(sse, "message_start")).toHaveLength(1)
    expect(dataFramesOfType(sse, "content_block_start")).toHaveLength(1)

    // The clean terminator: a synthetic Anthropic `error` event (NOT a silent close).
    const errors = dataFramesOfType(sse, "error")
    expect(errors).toHaveLength(1)
    expect((errors[0].error as Record<string, unknown>).type).toBe("api_error")
    expect(String((errors[0].error as Record<string, unknown>).message)).toContain("truncated")

    // The upstream never sent message_stop, so the proxy must not synthesize one.
    expect(dataFramesOfType(sse, "message_stop")).toHaveLength(0)
  })

  test("truncated stream → history records FAILED, preserving the partial content", async () => {
    frameBuilder = buildTruncatedFrames
    const sessionId = "trunc-history-failed"
    await streamRequest(sessionId)

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry).toBeDefined()

    // No longer a silent success: the entry is FAILED with a truncation reason.
    expect(entry.state).toBe("failed")
    expect(entry.attempts?.at(-1)?.upstreamResponse?.success).toBe(false)
    expect(String(entry._index?.derived?.failureReason)).toContain("truncated")

    // richest-data-flow: the accumulated partial (the half-streamed tool_use) is kept,
    // not nulled — the residual is observable diagnostic data.
    expect(entry.attempts?.at(-1)?.upstreamResponse?.body).not.toBeNull()

    // The raw upstream track is preserved verbatim (no synthesized terminator in it).
    const upTypes = (entry.attempts?.at(-1)?.upstreamResponse?.sseEvents ?? []).map((e) => safeParse(e.raw)?.type)
    expect(upTypes).toContain("content_block_start")
    expect(upTypes).not.toContain("message_stop")
  })

  test("complete stream (regression) → still settles as success and ends with message_stop", async () => {
    frameBuilder = buildCompleteFrames
    const sessionId = "trunc-complete-regression"
    const sse = await streamRequest(sessionId)

    // The client gets a real message_stop and NO synthetic error.
    expect(dataFramesOfType(sse, "message_stop")).toHaveLength(1)
    expect(dataFramesOfType(sse, "error")).toHaveLength(0)

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId, limit: 5 }).entries[0]
    expect(entry).toBeDefined()
    expect(entry.state).toBe("completed")
    expect(entry.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
  })
})

function safeParse(raw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
}
