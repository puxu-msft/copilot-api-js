/**
 * L2 (streaming buffered retry) regression BASELINE — Phase 0.
 *
 * Locks the CURRENT live-streaming behavior of the Anthropic `/v1/messages` pump
 * for the two scenarios L2 touches, BEFORE any L2 code lands:
 *   1. a complete stream → exact forwarded SSE (byte golden) + history `completed`
 *   2. a mid-stream upstream RST (errored stream = real `NGHTTP2_CANCEL` shape,
 *      classifyStreamError → transport-close) → the client receives the partial
 *      frames + a synthetic Anthropic `error` event, NO `message_stop`, history `failed`.
 *
 * After L2 lands with `protect_streaming_generation` DEFAULT (false), these golden
 * MUST still pass byte-for-byte — proving the default live path is untouched (the
 * commit-invariant for every L2 phase). See
 * docs/rfc/streaming-upstream-rst-buffered-retry.md §11 Phase 0.
 *
 * NOT a clean-EOF truncation (that is stream-truncation.http.test.ts) NOR a client
 * disconnect (streaming-abort.http.test.ts) — this is an upstream-ERRORED stream.
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

/** thinking-less complete generation: text block + a Write tool_use block + terminal sequence. */
function buildCompleteFrames(model: string): Array<string> {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_l2", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Writing the file." } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_l2", name: "Write", input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path": "/tmp/x.md", "content": "# hi"}' } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    "data: [DONE]\n\n",
  ]
}

/** Up to (and including) the partial tool_use, then the upstream stream ERRORS (RST). */
function buildPartialFrames(model: string): Array<string> {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_l2r", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_l2r", name: "Write", input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path": "/tmp/big.md", "content": "# partial' } })}\n\n`,
    // then controller.error(NGHTTP2_CANCEL) — see createSseResponseThenError below.
  ]
}

const RST_ERROR = new Error("Stream closed with error code NGHTTP2_CANCEL")

let mode: "complete" | "rst" = "complete"

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  const model = payload.model ?? MODEL
  if (url.endsWith("/v1/messages")) {
    return Promise.resolve(
      mode === "complete" ? createSseResponse(buildCompleteFrames(model)) : createSseResponseThenError(buildPartialFrames(model), RST_ERROR),
    )
  }
  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

async function streamRequest(sessionId: string): Promise<string> {
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "write a file" }], max_tokens: 256, stream: true }),
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

describe("L2 baseline — Anthropic live streaming (locked before L2 lands)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    mode = "complete"
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
      streamIdleTimeout: 0,
      anthropicFakeSseHeartbeat: 0,
    })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("complete stream → forwarded frames in exact order + tool_use content intact + history completed", async () => {
    mode = "complete"
    const sse = await streamRequest("l2-base-complete")

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
    // The Write tool_use input survives byte-for-byte (no decode/filter trigger here):
    // parse the input_json_delta frame and compare its partial_json to the original.
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
      .find((o) => o?.type === "content_block_delta" && o.index === 1 && o.delta?.type === "input_json_delta")
    expect(toolDelta?.delta?.partial_json).toBe('{"file_path": "/tmp/x.md", "content": "# hi"}')

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "l2-base-complete", limit: 5 }).entries[0]
    expect(entry?.state).toBe("completed")
    expect(entry?.outboundResponse?.success).toBe(true)
  })

  test("mid-stream transport-close (NGHTTP2_CANCEL) → partial frames + synthetic error, NO message_stop, history failed", async () => {
    mode = "rst"
    const sse = await streamRequest("l2-base-rst")

    const types = frameTypesInOrder(sse)
    // The partial the upstream DID send is forwarded (live streaming can't unsend).
    expect(types.slice(0, 3)).toEqual(["message_start", "content_block_start", "content_block_delta"])
    // Current behavior: a synthetic Anthropic `error` terminator, and NO message_stop.
    expect(types).toContain("error")
    expect(types).not.toContain("message_stop")

    const entry = getHistory({ endpoint: "anthropic-messages", sessionId: "l2-base-rst", limit: 5 }).entries[0]
    expect(entry?.state).toBe("failed")
    expect(entry?.outboundResponse?.success).toBe(false)
    expect(String(entry?.outboundResponse?.error)).toContain("NGHTTP2_CANCEL")
  })
})
