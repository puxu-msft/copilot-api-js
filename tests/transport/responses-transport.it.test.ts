import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { Model } from "~/lib/models/client"
import type { UpstreamWsConnection } from "~/lib/openai/upstream-ws-connection"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { PreparedRequest } from "~/lib/pipeline/types"

import { cancellationAbortError } from "~/lib/error/cancellation-reason"
import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  getUpstreamWsManager,
  resetUpstreamWsManagerForTests,
  setUpstreamWsConnectionFactoryForTests,
} from "~/lib/openai/upstream-ws"
import { setStateForTests } from "~/lib/state"
import { StreamReaperCancelError } from "~/lib/stream"
import { UpstreamTransportFallbackError } from "~/lib/transport/fallback"
import { createUpstreamResponsesTransport } from "~/lib/transport/responses-transport"

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

function makeWire(): PreparedRequest {
  return {
    url: ENDPOINT.RESPONSES,
    headers: new Headers({ Authorization: "Bearer test" }),
    body: { model: "gpt-5.2", input: "hello", stream: true },
    stream: true,
  }
}

function makeEnv(transports: Array<string>, clientAbortSignal?: AbortSignal, lifecycleSignal?: AbortSignal): RequestEnvelope {
  const model = {
    id: "gpt-5.2",
    name: "gpt-5.2",
    vendor: "OpenAI",
    supported_endpoints: [ENDPOINT.RESPONSES, ENDPOINT.WS_RESPONSES],
  } as Model
  return {
    model,
    ctx: {
      lifecycleSignal: lifecycleSignal ?? new AbortController().signal,
      setAttemptTransport: (transport: string) => transports.push(transport),
    },
    clientAbortSignal,
  } as unknown as RequestEnvelope
}

function failingConnection(onSend: () => void, onClose: () => void): UpstreamWsConnection {
  return {
    connect: async () => {},
    sendRequest: () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<never>> {
            onSend()
            throw new Error("WS closed before first event")
          },
        }
      },
    }),
    isOpen: true,
    isBusy: false,
    statefulMarker: undefined,
    model: "gpt-5.2",
    conversationId: undefined,
    handshakeHeaders: {},
    rescheduleIdleTimeout: () => {},
    close: onClose,
    dispose: async () => onClose(),
  }
}

describe("createUpstreamResponsesTransport — explicit WS fallback dispatch", () => {
  autoRestoreState()
  autoRestoreFetch()

  let wsSends = 0
  let wsCloses = 0

  beforeEach(() => {
    wsSends = 0
    wsCloses = 0
    setStateForTests({ upstreamWebSocket: true, responseHeaderTimeout: 0 })
    resetUpstreamWsManagerForTests()
    setUpstreamWsConnectionFactoryForTests(() =>
      failingConnection(
        () => wsSends++,
        () => wsCloses++,
      ),
    )
  })

  afterEach(() => {
    setUpstreamWsConnectionFactoryForTests(null)
    resetUpstreamWsManagerForTests()
  })

  test("WS first-event failure surfaces control flow; forced HTTP is a separate call", async () => {
    const transports: Array<string> = []
    const env = makeEnv(transports)
    const transport = createUpstreamResponsesTransport({ idleTimeoutMs: 5000 })
    setFetchMock(() => createSseResponse(['event: response.created\ndata: {"type":"response.created"}\n\n']))

    await expect(transport.send(makeWire(), env)).rejects.toBeInstanceOf(UpstreamTransportFallbackError)
    expect(wsSends).toBe(1)
    expect(wsCloses).toBe(1)
    expect(transports).toEqual(["upstream-ws"])

    const upstream = await transport.send(makeWire(), env, { forceHttp: true })
    const iterator = upstream.frames[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.event).toBe("response.created")
    expect(wsSends).toBe(1)
    expect(transports).toEqual(["upstream-ws", "http"])
  })

  test("physical open returns a typed fallback-before-first-event result", async () => {
    const transports: Array<string> = []
    const transport = createUpstreamResponsesTransport({ idleTimeoutMs: 5000 })

    const result = await transport.open(makeWire(), makeEnv(transports))

    expect(result.kind).toBe("fallback-before-first-event")
    await expect(result.lifecycle.quiesced).resolves.toBeUndefined()
    expect(transports).toEqual(["upstream-ws"])
  })

  test("client cancellation never becomes an HTTP fallback dispatch", async () => {
    const clientAbort = new AbortController()
    clientAbort.abort(new DOMException("The operation was aborted.", "AbortError"))
    const transports: Array<string> = []
    const env = makeEnv(transports, clientAbort.signal)
    const transport = createUpstreamResponsesTransport({ idleTimeoutMs: 5000, clientAbortSignal: clientAbort.signal })
    let httpCalls = 0
    setFetchMock(() => {
      httpCalls++
      return createSseResponse([])
    })

    await expect(transport.send(makeWire(), env)).rejects.not.toBeInstanceOf(UpstreamTransportFallbackError)
    expect(httpCalls).toBe(0)
    expect(transports).toEqual(["upstream-ws"])
  })

  test("mid-stream reaper (ctx.lifecycleSignal) on the HTTP path → guarded frames throw StreamReaperCancelError (Responses-fallback false-`complete` guard)", async () => {
    // responses-transport folds `env.ctx.lifecycleSignal` into `guardWsOrHttp`'s reaperSignal
    // (responses-transport.ts:152). This is the acute case behind the whole reaper-teeth effort: a
    // mid-stream reaper cancel on a Responses stream must throw `StreamReaperCancelError` (→ driver
    // stream-error → client error frame + `failed`), NOT resolve `done:true`. If it clean-EOF'd, the
    // handler's `viaFallback` branch synthesizes `response.completed`, sets `acc.status`, bypasses the
    // truncation check, and false-settles `complete` — an [OK] recorded for a request the reaper killed.
    // The `forceHttp` dispatch is the exact guarded source the fallback path consumes.
    const reaper = new AbortController()
    const transports: Array<string> = []
    const env = makeEnv(transports, undefined, reaper.signal)
    const transport = createUpstreamResponsesTransport({ idleTimeoutMs: 5000 })
    setFetchMock(() => createSseResponseThenBlock(['event: response.created\ndata: {"type":"response.created"}\n\n']))

    const upstream = await transport.send(makeWire(), env, { forceHttp: true })
    const iterator = upstream.frames[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.event).toBe("response.created")

    // Reaper force-fails mid-stream (upstream blocked past the last frame). Abort WITH the cause tag
    // the real `ctx.reapInFlight()` carries — a bare abort simulates the producer without its contract.
    reaper.abort(cancellationAbortError("stale-reaper", "Request cancelled by the stale-request reaper"))
    await expect(iterator.next()).rejects.toBeInstanceOf(StreamReaperCancelError)
  })

  test("dispatch-local loser cancellation never becomes an HTTP fallback dispatch", async () => {
    const dispatchAbort = new AbortController()
    dispatchAbort.abort(new DOMException("candidate lost", "AbortError"))
    const transports: Array<string> = []
    const env = makeEnv(transports)
    const transport = createUpstreamResponsesTransport({ idleTimeoutMs: 5000 })
    let httpCalls = 0
    setFetchMock(() => {
      httpCalls++
      return createSseResponse([])
    })

    await expect(transport.send(makeWire(), env, { signal: dispatchAbort.signal })).rejects.not.toBeInstanceOf(UpstreamTransportFallbackError)
    expect(wsSends).toBe(0)
    expect(httpCalls).toBe(0)
    expect(transports).toEqual(["upstream-ws"])
    expect(getUpstreamWsManager().consecutiveFallbacks("gpt-5.2")).toBe(0)
  })
})
