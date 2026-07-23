import {
  //
  expect,
  mock,
  test,
} from "bun:test"

import { getHistory } from "~/lib/history"
import { drainV3Writer } from "~/lib/history/v3/store"
import { getDimensionBreakdown } from "~/lib/request-telemetry"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import { createFullTestApp } from "../helpers/test-app"

const MODEL = "claude-sonnet-4.6"
const app = createFullTestApp()

function frame(event: string, value: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
}

function maxTokensThinkingStream(): Array<string> {
  return [
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg-max-tokens",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 4 } }),
    frame("message_stop", { type: "message_stop" }),
    "data: [DONE]\n\n",
  ]
}

function setup(): void {
  setStateForTests({ copilotToken: "test-token", accountType: "individual", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0 })
  setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  applyFetchMock(
    mock(async () => new Response(createSseResponse(maxTokensThinkingStream()).body, { status: 200, headers: { "content-type": "text/event-stream" } })),
  )
}

useIsolatedRuntime()

test("Anthropic direct max_tokens thinking terminal persists its observed class while enabled=false leaves client stop_reason unchanged", async () => {
  setup()

  const response = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4, stream: true, messages: [{ role: "user", content: "think" }] }),
  })

  expect(response.status).toBe(200)
  const wire = await response.text()
  expect(wire).toContain('"stop_reason":"max_tokens"')
  await drainV3Writer()

  const entry = getHistory({ endpoint: "anthropic-messages" }).entries[0]
  expect(entry?.pipelineInfo?.maxTokensContinuation).toMatchObject({
    truncationClass: "thinking",
    roundsAttempted: 1,
    roundsSucceeded: 0,
    continuedTokens: 0,
    perRoundStopReason: ["max_tokens"],
    clientVisibleStopReason: "max_tokens",
    suppressedMaxTokens: false,
    visibilityMode: "passthrough",
  })

  const telemetry = getDimensionBreakdown("max_tokens_truncation", "sinceStart")
  expect(telemetry.keys).toContainEqual(expect.objectContaining({ key: "thinking", counters: expect.objectContaining({ requestCount: 1 }) }))
})
