/**
 * v4 — upstream HTTP Transport adapter tests.
 *
 * Drives `createUpstreamHttpTransport` with a mocked fetch: asserts the streaming
 * path (guarded SSE frames + captured response headers), the non-streaming path
 * (`nonStream` JSON + empty frames), and HTTPError surfacing on a non-ok upstream.
 * Touches the adaptive rate-limiter singleton + global state, hence `.it.test`.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HeadersCapture } from "~/lib/context/request"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  PreparedRequest,
  UpstreamFrame,
} from "~/lib/pipeline/types"

import { resetAdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import { createUpstreamHttpTransport } from "~/lib/transport/http-transport"

import {
  //
  autoRestoreFetch,
  setFetchMock,
} from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import { autoRestoreState } from "../helpers/state-fixture"

function makeEnv(): RequestEnvelope {
  return { model: { id: "gpt-4o" }, clientFormat: "openai-cc" } as unknown as RequestEnvelope
}

function makeWire(over?: Partial<PreparedRequest>): PreparedRequest {
  return {
    url: "/chat/completions",
    headers: new Headers({ Authorization: "Bearer x" }),
    body: { model: "gpt-4o", messages: [], stream: true },
    stream: true,
    ...over,
  }
}

async function collect(frames: AsyncIterable<UpstreamFrame>): Promise<Array<UpstreamFrame>> {
  const out: Array<UpstreamFrame> = []
  for await (const f of frames) out.push(f)
  return out
}

describe("createUpstreamHttpTransport", () => {
  autoRestoreState()
  autoRestoreFetch()

  beforeEach(() => {
    resetAdaptiveRateLimiter()
  })

  test("streaming: returns guarded SSE frames + captured response headers", async () => {
    setFetchMock(() => {
      const res = createSseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"])
      res.headers.set("x-upstream", "yes")
      return res
    })
    const headersCapture: HeadersCapture = {}
    const transport = createUpstreamHttpTransport({ headersCapture, idleTimeoutMs: 5000 })

    const upstream = await transport.send(makeWire({ stream: true }), makeEnv())
    const frames = await collect(upstream.frames)
    expect(frames.map((f) => f.data)).toEqual(['{"choices":[{"delta":{"content":"hi"}}]}', "[DONE]"])
    expect(upstream.nonStream).toBeUndefined()
    expect(upstream.headers.get("x-upstream")).toBe("yes")
  })

  test("non-streaming: returns nonStream JSON + empty frames", async () => {
    setFetchMock(() => new Response(JSON.stringify({ id: "cc-1", choices: [] }), { status: 200, headers: { "content-type": "application/json" } }))
    const transport = createUpstreamHttpTransport({ headersCapture: {}, idleTimeoutMs: 5000 })

    const upstream = await transport.send(makeWire({ stream: false, body: { model: "gpt-4o", messages: [], stream: false } }), makeEnv())
    expect(await collect(upstream.frames)).toEqual([])
    expect(upstream.nonStream).toEqual({ id: "cc-1", choices: [] })
  })

  test("non-ok upstream → throws HTTPError with the endpoint's error label", async () => {
    setFetchMock(() => new Response(JSON.stringify({ error: "bad" }), { status: 400, headers: { "content-type": "application/json" } }))
    const transport = createUpstreamHttpTransport({ headersCapture: {}, idleTimeoutMs: 5000 })

    await expect(transport.send(makeWire({ stream: false, body: { model: "gpt-4o", messages: [], stream: false } }), makeEnv())).rejects.toThrow(
      /Failed to create chat completions/,
    )
  })

  test("via-responses url → uses the responses error label on failure", async () => {
    setFetchMock(() => new Response("nope", { status: 500 }))
    const transport = createUpstreamHttpTransport({ headersCapture: {}, idleTimeoutMs: 5000 })

    await expect(transport.send(makeWire({ url: "/responses", stream: false, body: { model: "gpt-5", input: [], stream: false } }), makeEnv())).rejects.toThrow(
      /Failed to create responses/,
    )
  })
})
