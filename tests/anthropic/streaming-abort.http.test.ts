/**
 * Handler-level abort wiring (Bug 2): drives the real Anthropic streaming
 * response handler and asserts that a mid-stream client disconnect settles the
 * RequestContext as `aborted` (via settleStreamingFailure) and does NOT write a
 * client-facing error frame to the (closed) stream.
 *
 * Determinism: the mock upstream yields one event, then aborts the client
 * signal and blocks forever. When the handler calls next() for the 2nd event,
 * the abort wins the race (the blocked next() never resolves), so
 * processAnthropicStream throws StreamClientAbortError — no timers, no flakiness.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"

import { createRequestContext } from "~/lib/context/request"
import {
  //
  setStateForTests,
  state,
} from "~/lib/state"
import { handleDirectAnthropicStreamingResponse } from "~/routes/messages/handler"

const MESSAGE_START: ServerSentEventMessage = {
  data: JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-opus-4.6",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 0 },
    },
  }),
}

describe("handleDirectAnthropicStreamingResponse — client abort settles aborted", () => {
  const savedIdle = state.streamIdleTimeout
  afterEach(() => {
    setStateForTests({ streamIdleTimeout: savedIdle })
  })

  test("mid-stream client disconnect → ctx.state 'aborted', no error frame, partial preserved", async () => {
    setStateForTests({ streamIdleTimeout: 0 })

    const writes: Array<ServerSentEventMessage> = []
    const stream = {
      writeSSE: async (msg: ServerSentEventMessage) => {
        writes.push(msg)
      },
    }

    const clientAbort = new AbortController()
    // Yield one event, then disconnect the client and block: the handler's 2nd
    // next() never resolves, so the abort deterministically wins the race.
    async function* upstream(): AsyncGenerator<ServerSentEventMessage> {
      yield MESSAGE_START
      clientAbort.abort()
      await new Promise<never>(() => {})
    }

    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    const payload = { model: "claude-opus-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 64 } as unknown as MessagesPayload
    ctx.setOriginalRequest({ model: payload.model, messages: payload.messages, stream: true, payload })

    await handleDirectAnthropicStreamingResponse({
      stream: stream as unknown as Parameters<typeof handleDirectAnthropicStreamingResponse>[0]["stream"],
      response: upstream(),
      anthropicPayload: payload,
      reqCtx: ctx,
      clientAbortSignal: clientAbort.signal,
    })

    // Settled as the distinct `aborted` terminal — NOT completed/failed.
    expect(ctx.state).toBe("aborted")
    expect(ctx.settled).toBe(true)
    // The first streamed frame WAS forwarded before the disconnect…
    expect(writes.some((w) => typeof w.data === "string" && w.data.includes("message_start"))).toBe(true)
    // …but NO error frame was written to the gone client.
    expect(writes.some((w) => w.event === "error")).toBe(false)
    // Partial usage observed before the disconnect is preserved on the response.
    expect(ctx.response?.usage.input_tokens).toBe(11)
    expect(ctx.response?.success).toBe(false)
  })
})
