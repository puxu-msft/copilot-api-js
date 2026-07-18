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
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  PreparedRequest,
  UpstreamFrame,
} from "~/lib/pipeline/types"

import { resetAdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import {
  //
  _resetShutdownState,
  gracefulShutdown,
} from "~/lib/shutdown"
import { createUpstreamHttpTransport } from "~/lib/transport/http-transport"

import {
  //
  autoRestoreFetch,
  setFetchMock,
} from "../helpers/mock-fetch"
import { createMockServer } from "../helpers/mock-server"
import { createMockTracker } from "../helpers/mock-tracker"
import { createSseResponse } from "../helpers/sse"
import { autoRestoreState } from "../helpers/state-fixture"

function makeEnv(): RequestEnvelope {
  const ctx = { addQueueWaitMs: () => {} }
  return { model: { id: "gpt-4o" }, clientFormat: "openai-cc", ctx } as unknown as RequestEnvelope
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
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 5000 })

    const upstream = await transport.send(makeWire({ stream: true }), makeEnv())
    const frames = await collect(upstream.frames)
    expect(frames.map((f) => f.data)).toEqual(['{"choices":[{"delta":{"content":"hi"}}]}', "[DONE]"])
    expect(upstream.nonStream).toBeUndefined()
    expect(upstream.headers.get("x-upstream")).toBe("yes")
    expect(upstream.lifecycle).toBeDefined()
    await expect(upstream.lifecycle!.quiesced).resolves.toBeUndefined()
    await expect(upstream.lifecycle!.dispose()).resolves.toEqual({ quiesced: true, connectionReusable: true })
  })

  test("physical open returns a mandatory stream lifecycle", async () => {
    setFetchMock(() => createSseResponse(['data: {"choices":[]}\n\n']))
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 5000 })

    const result = await transport.open(makeWire({ stream: true }), makeEnv())

    expect(result.kind).toBe("stream")
    if (result.kind !== "stream") throw new Error("expected stream physical result")
    expect(result.lifecycle).toBeDefined()
    await result.lifecycle.dispose("test")
  })

  test("client abort disposes an unconsumed streaming body before quiesced resolves", async () => {
    const clientAbort = new AbortController()
    setFetchMock(() => createSseResponse(['data: {"choices":[]}\n\n']))
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 5000, clientAbortSignal: clientAbort.signal })
    const upstream = await transport.send(makeWire({ stream: true }), makeEnv())

    clientAbort.abort()

    await expect(upstream.lifecycle!.quiesced).resolves.toBeUndefined()
    const iterator = upstream.frames[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow(/abort|cancel/i)
  })

  test("non-streaming: returns nonStream JSON + empty frames", async () => {
    setFetchMock(() => new Response(JSON.stringify({ id: "cc-1", choices: [] }), { status: 200, headers: { "content-type": "application/json" } }))
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 5000 })

    const upstream = await transport.send(makeWire({ stream: false, body: { model: "gpt-4o", messages: [], stream: false } }), makeEnv())
    expect(await collect(upstream.frames)).toEqual([])
    expect(upstream.nonStream).toEqual({ id: "cc-1", choices: [] })
    await expect(upstream.lifecycle!.quiesced).resolves.toBeUndefined()
  })

  test("physical open returns json and typed failed-open variants", async () => {
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 5000 })
    setFetchMock(() => new Response(JSON.stringify({ id: "json" }), { status: 200, headers: { "content-type": "application/json" } }))
    const success = await transport.open(makeWire({ stream: false }), makeEnv())
    expect(success).toMatchObject({ kind: "json", body: { id: "json" } })

    setFetchMock(() => new Response("bad", { status: 500 }))
    const failed = await transport.open(makeWire({ stream: false }), makeEnv())
    expect(failed.kind).toBe("failed-open")
    await expect(failed.lifecycle.quiesced).resolves.toBeUndefined()
  })

  test("non-ok upstream → throws HTTPError with the endpoint's error label", async () => {
    setFetchMock(() => new Response(JSON.stringify({ error: "bad" }), { status: 400, headers: { "content-type": "application/json" } }))
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 5000 })

    await expect(transport.send(makeWire({ stream: false, body: { model: "gpt-4o", messages: [], stream: false } }), makeEnv())).rejects.toThrow(
      /Failed to create chat completions/,
    )
  })

  test("via-responses url → uses the responses error label on failure", async () => {
    setFetchMock(() => new Response("nope", { status: 500 }))
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 5000 })

    await expect(transport.send(makeWire({ url: "/responses", stream: false, body: { model: "gpt-5", input: [], stream: false } }), makeEnv())).rejects.toThrow(
      /Failed to create responses/,
    )
  })
})

// ── C1: rewriteShutdownAbort 529 hook (RFC §12.1) ──────────────────────────
// The Anthropic v4 transport opts in: a shutdown-caused non-streaming AbortError
// becomes a retryable 529 (parity with the legacy Anthropic client). Every other
// caller (and the client-disconnect case) re-throws the ORIGINAL AbortError.

describe("createUpstreamHttpTransport — rewriteShutdownAbort 529 hook", () => {
  autoRestoreState()
  autoRestoreFetch()

  beforeEach(() => {
    resetAdaptiveRateLimiter()
  })
  afterEach(() => {
    // gracefulShutdown aborts the shutdown controller; reset so it doesn't leak.
    _resetShutdownState()
  })

  test("hook OFF (default): a fetch AbortError re-throws the ORIGINAL object unchanged (CC/Responses parity, identity preserved)", async () => {
    const abortErr = new DOMException("The operation was aborted", "AbortError")
    setFetchMock(() => new Promise<Response>((_resolve, reject) => reject(abortErr)))
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 5000 })

    let caught: unknown
    try {
      await transport.send(makeWire({ stream: false, body: { model: "gpt-4o", messages: [], stream: false } }), makeEnv())
    } catch (e) {
      caught = e
    }
    expect(caught).toBe(abortErr) // same object — not rewritten to a 529 HTTPError
  })

  test("hook ON but NO shutdown (client-disconnect): AbortError NEVER becomes 529 — re-throws the original", async () => {
    const abortErr = new DOMException("The operation was aborted", "AbortError")
    setFetchMock(() => new Promise<Response>((_resolve, reject) => reject(abortErr)))
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 5000, rewriteShutdownAbort: true })

    let caught: unknown
    try {
      await transport.send(makeWire({ stream: false, body: { model: "claude", messages: [], stream: false } }), makeEnv())
    } catch (e) {
      caught = e
    }
    expect(caught).toBe(abortErr) // getShutdownSignal().aborted is false → original, not 529
  })

  test("hook ON + shutdown abort: a non-streaming AbortError → retryable HTTPError 529 (Anthropic parity)", async () => {
    // Upstream rejects with AbortError once the (shutdown-folded) fetch signal aborts.
    setFetchMock(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          const onAbort = (): void => reject(new DOMException("The operation was aborted", "AbortError"))
          if (signal?.aborted) return onAbort()
          signal?.addEventListener("abort", onAbort, { once: true })
        }),
    )
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 5000, rewriteShutdownAbort: true })

    const shutdownPromise = gracefulShutdown("SIGTERM", {
      tracker: createMockTracker([{ status: "streaming" }]),
      server: createMockServer(),
      rateLimiter: null,
      stopTokenRefreshFn: () => {},
      closeAllClientsFn: () => {},
      getClientCountFn: () => 0,
      contextManager: { stopReaper: () => {} },
      gracefulWaitMs: 50,
      abortWaitMs: 500,
      drainPollIntervalMs: 10,
      drainProgressIntervalMs: 50_000,
    })

    await expect(transport.send(makeWire({ stream: false, body: { model: "claude", messages: [], stream: false } }), makeEnv())).rejects.toMatchObject({
      status: 529,
    })
    await shutdownPromise
  })
})
