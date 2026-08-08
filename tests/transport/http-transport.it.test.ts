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

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  PreparedRequest,
  UpstreamFrame,
} from "~/lib/pipeline/types"

import { resetAdaptiveRateLimiter } from "~/lib/adaptive-rate-limiter"
import { cancellationAbortError } from "~/lib/error/cancellation-reason"
import { ENDPOINT } from "~/lib/models/endpoint"
import { StreamReaperCancelError } from "~/lib/stream"
import { createUpstreamHttpTransport } from "~/lib/transport/http-transport"

import {
  //
  autoRestoreFetch,
  setFetchMock,
} from "../helpers/mock-fetch"
import {
  //
  createSseResponse,
  createSseResponseThenBlock,
} from "../helpers/sse"
import { autoRestoreState } from "../helpers/state-fixture"

function makeEnv(over?: { lifecycleSignal?: AbortSignal }): RequestEnvelope {
  const ctx = { addQueueWaitMs: () => {}, lifecycleSignal: over?.lifecycleSignal }
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

  test("mid-stream reaper (ctx.lifecycleSignal) → guarded frames throw StreamReaperCancelError (live client gets a frame, NOT clean-EOF/settled-abort)", async () => {
    // The transport folds `env.ctx.lifecycleSignal` into the guard's `reaperSignal` (http-transport.ts:88/119).
    // When the stale reaper / request-deadline force-fails an ACTIVELY STREAMING request, that signal fires
    // mid-stream and the guard must throw `StreamReaperCancelError` — its OWN provenance, distinct from a
    // client disconnect. That routes to the driver's `stream-error` outcome, so the handler delivers a
    // terminal error frame to the STILL-CONNECTED client + settles `failed`. This is the regression guard for
    // the wiring: if `reaperSignal: env.ctx.lifecycleSignal` were dropped, a mid-stream reap would only abort
    // the fetch (post-response) → Bun delivers that local close as a clean `done:true` → the handler would
    // false-settle `complete` (an [OK] observability LIE, acute on Responses-via-fallback whose synthesized
    // `response.completed` masks the truncation). Unit-level guard/classify tests can't catch a dropped
    // transport wire — this .it seam can.
    const reaper = new AbortController()
    setFetchMock(() => createSseResponseThenBlock(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n']))
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 5000 })
    const upstream = await transport.send(makeWire({ stream: true }), makeEnv({ lifecycleSignal: reaper.signal }))

    const iterator = upstream.frames[Symbol.asyncIterator]()
    // The first real frame flows through the guard normally.
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect((first.value as UpstreamFrame).data).toBe('{"choices":[{"delta":{"content":"hi"}}]}')

    // Reaper force-fails mid-stream (upstream is now blocked, past the last frame). Abort WITH the
    // cause tag the real `ctx.reapInFlight()` carries — a bare abort would simulate the producer
    // without its contract, and now correctly classifies as an unknown cancel instead.
    reaper.abort(cancellationAbortError("stale-reaper", "Request cancelled by the stale-request reaper"))
    await expect(iterator.next()).rejects.toBeInstanceOf(StreamReaperCancelError)
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

  // Guards the load-bearing wire.url contract (client-query-forwarding Step 6): the forwarded
  // query is appended to endpointPath ONLY — `errorLabelFor(wire.url)` must keep seeing the clean
  // path. If a future refactor mutated `wire.url` to carry the query, errorLabelFor would fall
  // through to the generic "chat completions" label and this assertion would fail.
  test("forwarded query present → endpointPath gets the query, errorLabelFor keeps the clean MESSAGES label", async () => {
    let capturedUrl = ""
    setFetchMock((input) => {
      capturedUrl =
        typeof input === "string" ? input
        : input instanceof URL ? input.href
        : input.url
      return new Response(JSON.stringify({ error: "bad" }), { status: 400, headers: { "content-type": "application/json" } })
    })
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 5000 })
    const env = {
      model: { id: "claude" },
      clientFormat: "anthropic",
      ctx: { addQueueWaitMs: () => {}, query: { raw: "?beta=true", forwarded: "?beta=true" } },
    } as unknown as RequestEnvelope

    await expect(
      transport.send(makeWire({ url: ENDPOINT.MESSAGES, stream: false, body: { model: "claude", messages: [], stream: false } }), env),
    ).rejects.toThrow(/Failed to create messages/) // NOT the generic fallback → errorLabelFor saw the clean wire.url
    expect(new URL(capturedUrl).searchParams.get("beta")).toBe("true") // query reached the upstream URL on the error path too
  })
})

// ── Request cancellation identity ──────────────────────────────────────────
describe("createUpstreamHttpTransport — request cancellation identity", () => {
  autoRestoreFetch()

  test("a request AbortError re-throws the original object unchanged", async () => {
    const abortErr = new DOMException("The operation was aborted", "AbortError")
    setFetchMock(() => new Promise<Response>((_resolve, reject) => reject(abortErr)))
    const transport = createUpstreamHttpTransport({ idleTimeoutMs: 5000 })

    let caught: unknown
    try {
      await transport.send(makeWire({ stream: false, body: { model: "gpt-4o", messages: [], stream: false } }), makeEnv())
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(abortErr)
  })
})
