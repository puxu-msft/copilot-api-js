/**
 * Companion to `i9-h2-buffered-probe.http.test.ts` (Task 37 seam re-review).
 *
 * What this pins: content already committed by an earlier boundary survives a terminal upstream error, the error reaches the client, and nothing is retried — across BOTH settings of `errorShapingEnabled`, because with shaping off the `error` frame arrives as `event: error` with no canonical `type` in its body and the adapter has to recognise it from the event line alone.
 *
 * What this does NOT pin, stated because a reviewer measured it: it is not a control for "the error frame is itself a commit boundary". Deleting the adapter's `error` case leaves this test green — the preceding `content_block_stop` has already flushed the block, and once bytes are committed the retry gate refuses to retry regardless of how the error is classified. The shape is structurally incapable of discriminating that mechanism.
 *
 * The mechanism controls live elsewhere: `i9-h2-buffered-probe` (error with no prior content — discriminates the retry decision) and `i9-followup-midblock-error` (error mid-block — discriminates the grammar's failed-terminal branch).
 */
import {
  //
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
  messageStartFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import {
  //
  createSseResponse,
  frameTypesInOrder,
} from "../helpers/sse"

const MODEL = "claude-sonnet-4.6"

/** message_start → one COMPLETE content block → terminal upstream `event:error`, with no message_stop. */
function buildCommittedBlockThenH2(model: string): Array<string> {
  return [
    messageStartFrame({ id: "msg_h2commit", model }),
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "committed-prefix" } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: error\ndata: ${JSON.stringify({ error: { type: "overloaded_error", message: "upstream overloaded" } })}\n\n`,
  ]
}

let upstreamCalls = 0
const upstreamFetchMock = mock(() => {
  upstreamCalls++
  return Promise.resolve(createSseResponse(buildCommittedBlockThenH2(MODEL)))
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

describe.each([true, false])("H2 terminal error after a committed block, on the L2 buffered path (errorShapingEnabled=%s)", (errorShapingEnabled) => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    upstreamCalls = 0
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      staleRequestMaxAge: 0,
      streamKeepalivePingSec: 0,
      protectStreamingGeneration: "on",
      errorShapingEnabled,
      bufferedRetryShared: { maxRetries: 3, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      bufferedRetryContinuationShared: { enabled: false, message: "network issue. please continue" },
    })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("delivers the already-committed block AND surfaces the error, without retrying", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": `h2-committed-block-${String(errorShapingEnabled)}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: true }),
    })
    expect(res.status).toBe(200)
    const sse = await res.text()
    const types = frameTypesInOrder(sse)

    expect(sse).toContain("committed-prefix")
    expect(types).toContain("content_block_stop")
    expect(types).toContain("error")
    expect(upstreamCalls).toBe(1)
  })
})
