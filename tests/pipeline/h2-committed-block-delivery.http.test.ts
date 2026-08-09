/**
 * Companion to `i9-h2-buffered-probe.http.test.ts` (Task 37 seam re-review).
 *
 * That probe pins the retry decision: an H2 terminal `event:error` must not be retried as a truncation.
 * This one pins the OTHER half of the same spec rule — delivery. Spec §5.3 M1 requires the H2 error frame to be taken into account "在 commitBoundaries 与重试判定中", i.e. content committed before the error must still reach the client, and the error must be surfaced rather than swallowed.
 * Without it, a fix that only satisfies the retry half would look complete while silently dropping a fully committed block.
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
import { createSseResponse, frameTypesInOrder } from "../helpers/sse"

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

describe("H2 terminal error after a committed block, on the L2 buffered path", () => {
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
      bufferedRetryShared: { maxRetries: 3, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
      bufferedRetryContinuationShared: { enabled: false, message: "network issue. please continue" },
    })
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  test("delivers the already-committed block AND surfaces the error, without retrying", async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "h2-committed-block" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: true }),
    })
    expect(res.status).toBe(200)
    const sse = await res.text()
    const types = frameTypesInOrder(sse)

    // The committed block must survive the terminal error — a fix that only stops the retry but drops the buffer would pass the sibling probe and fail here.
    expect(sse).toContain("committed-prefix")
    expect(types).toContain("content_block_stop")
    expect(types).toContain("error")
    expect(upstreamCalls).toBe(1)
  })
})
