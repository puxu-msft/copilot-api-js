import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"

import { createAnthropicMessages } from "~/lib/anthropic/client"
import { HTTPError } from "~/lib/error"
import { setStateForTests } from "~/lib/state"

import {
  //
  autoRestoreFetch,
  setFetchMock,
} from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import { autoRestoreState } from "../helpers/state-fixture"

function createPayload(overrides: Partial<MessagesPayload> = {}): MessagesPayload {
  return {
    model: "claude-sonnet-4.6",
    max_tokens: 128,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...overrides,
  }
}

describe("anthropic client", () => {
  autoRestoreFetch()
  autoRestoreState()

  beforeEach(() => {
    setStateForTests({
      accountType: "individual",
      copilotToken: "copilot-test-token",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      contextEditingMode: "off",
    })
  })

  test("returns JSON responses and captures raw headers (Phase 1: History stores unredacted)", async () => {
    const fetchMock = setFetchMock(
      async () =>
        new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4.6",
            content: [{ type: "text", text: "hello back" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 5,
            },
          }),
          {
            status: 200,
            headers: { "x-request-id": "resp-1" },
          },
        ),
    )

    const headersCapture: {
      request?: Record<string, string>
      response?: Record<string, string>
    } = {}
    const onPrepared = mock(() => {})

    const result = await createAnthropicMessages(createPayload(), {
      headersCapture,
      onPrepared,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      id: "msg_123",
      model: "claude-sonnet-4.6",
    })
    expect(headersCapture.request?.Authorization).toBe("Bearer copilot-test-token")
    expect(headersCapture.response?.["x-request-id"]).toBe("resp-1")
    expect(onPrepared).toHaveBeenCalledTimes(1)
  })

  test("returns an async iterable for streaming responses", async () => {
    setFetchMock(async () =>
      createSseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4.6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        "data: [DONE]\n\n",
      ]),
    )

    const result = await createAnthropicMessages(createPayload({ stream: true }))
    const iterator = (result as AsyncIterable<ServerSentEventMessage>)[Symbol.asyncIterator]()
    const first = await iterator.next()

    expect(first.done).toBe(false)
    expect(first.value?.event).toBe("message_start")
  })

  test("throws HTTPError for failed upstream responses", async () => {
    setFetchMock(async () => new Response("bad gateway", { status: 502 }))

    await expect(createAnthropicMessages(createPayload())).rejects.toBeInstanceOf(HTTPError)
  })

  test("drives the upstream timeout from our application-level abort signal", async () => {
    // The upstream request now goes through undici (transport/upstream-fetch.ts),
    // which has no built-in timeout clock (unlike Bun's global fetch). So
    // `timeouts.response_header` stays the single source of truth, carried via the
    // abort signal on the request rather than a `timeout:false` flag.
    setStateForTests({ responseHeaderTimeout: 600 })
    const fetchMock = setFetchMock(
      async () =>
        new Response(
          JSON.stringify({
            id: "msg_x",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4.6",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        ),
    )

    await createAnthropicMessages(createPayload())

    const init = fetchMock.mock.calls[0]?.[1] as { signal?: unknown } | undefined
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
})
