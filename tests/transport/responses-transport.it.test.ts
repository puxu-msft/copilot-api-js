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

import {
  //
  cancellationAbortError,
  getCancellationCause,
} from "~/lib/error/cancellation-reason"
import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  getUpstreamWsManager,
  resetUpstreamWsManagerForTests,
  setUpstreamWsConnectionFactoryForTests,
} from "~/lib/openai/upstream-ws"
import { createUpstreamWsConnection } from "~/lib/openai/upstream-ws-connection"
import { setStateForTests } from "~/lib/state"
import { StreamReaperCancelError } from "~/lib/stream"
import { UpstreamTransportFallbackError } from "~/lib/transport/fallback"
import { createUpstreamResponsesTransport } from "~/lib/transport/responses-transport"

import { compatDispatchOptionsForTests } from "../helpers/dispatch-options"
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

/**
 * A REAL connection over a socket that opens and then stays silent, so only the first-event
 * watchdog can end the attempt.
 *
 * Deliberately not a hand-rolled fake: the abort wiring under test lives INSIDE
 * `createUpstreamWsConnection`, so a fake `sendRequest` that honours `abortSignal` itself
 * would be asserting against the fake's own behaviour.
 */
function silentRealConnection(): UpstreamWsConnection {
  const socket = new (class extends EventTarget {
    readyState = 0
    readonly OPEN = 1
    readonly CONNECTING = 0
    readonly CLOSING = 2
    readonly CLOSED = 3
    constructor() {
      super()
      // The HANDSHAKE must succeed, or the watchdog is caught by `connect()` instead and the
      // first-event arm is never reached — a probe caught exactly that false positive here.
      setTimeout(() => {
        this.readyState = this.OPEN
        this.dispatchEvent(new Event("open"))
      }, 0)
    }
    send(): void {}
    close(): void {
      this.readyState = this.CLOSED
      this.dispatchEvent(new CloseEvent("close", { code: 1000, reason: "closed" }))
    }
  })()
  return createUpstreamWsConnection({ headers: {}, model: "gpt-5.2", idleTimeoutMs: 0, createSocket: () => socket as never })
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

    await expect(transport.send(makeWire(), env, compatDispatchOptionsForTests())).rejects.toBeInstanceOf(UpstreamTransportFallbackError)
    expect(wsSends).toBe(1)
    expect(wsCloses).toBe(1)
    expect(transports).toEqual(["upstream-ws"])

    const upstream = await transport.send(makeWire(), env, compatDispatchOptionsForTests({ forceHttp: true }))
    const iterator = upstream.frames[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.event).toBe("response.created")
    expect(wsSends).toBe(1)
    expect(transports).toEqual(["upstream-ws", "http"])
  })

  test("physical open returns a typed fallback-before-first-event result", async () => {
    const transports: Array<string> = []
    const transport = createUpstreamResponsesTransport({ idleTimeoutMs: 5000 })

    const result = await transport.open(makeWire(), makeEnv(transports), compatDispatchOptionsForTests())

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

    await expect(transport.send(makeWire(), env, compatDispatchOptionsForTests())).rejects.not.toBeInstanceOf(UpstreamTransportFallbackError)
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

    const upstream = await transport.send(makeWire(), env, compatDispatchOptionsForTests({ forceHttp: true }))
    const iterator = upstream.frames[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.event).toBe("response.created")

    // Reaper force-fails mid-stream (upstream blocked past the last frame). Abort WITH the cause tag
    // the real `ctx.reapInFlight()` carries — a bare abort simulates the producer without its contract.
    reaper.abort(cancellationAbortError("stale-reaper", "Request cancelled by the stale-request reaper"))
    await expect(iterator.next()).rejects.toBeInstanceOf(StreamReaperCancelError)
  })

  test("a PRE-first-event hard deadline never becomes an HTTP fallback, and stays readable as a deadline", async () => {
    // The sibling test above covers a CLIENT abort. The lifecycle signal (reaper / hard
    // deadline) rides a different arm of the same gate, and only that arm stops a request
    // we already gave up on from opening a second upstream dispatch. Deleting the gate
    // leaves every connection-primitive cause test green, so this is where it has to be caught.
    const lifecycle = new AbortController()
    lifecycle.abort(cancellationAbortError("request-deadline", "request_deadline"))
    const transports: Array<string> = []
    const env = makeEnv(transports, undefined, lifecycle.signal)
    const transport = createUpstreamResponsesTransport({ idleTimeoutMs: 5000 })
    let httpCalls = 0
    setFetchMock(() => {
      httpCalls++
      return createSseResponse([])
    })

    const error = await transport.send(makeWire(), env, compatDispatchOptionsForTests()).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).not.toBeInstanceOf(UpstreamTransportFallbackError)
    expect(httpCalls).toBe(0)
    expect(transports).toEqual(["upstream-ws"])
    // …and the boundary can still tell WHICH clock ended it, through the WS wrapper's cause chain.
    expect(getCancellationCause(error)).toBe("request-deadline")
  })

  test("the first-event watchdog keeps its TimeoutError identity in the fallback's cause chain", async () => {
    // The watchdog fires WS-side and legitimately turns into an HTTP fallback — that part is
    // by design. What must not be lost is WHY the WS attempt was discarded: `error.name` does
    // not travel the cause chain, so the watchdog has to pass its reason object through
    // untouched rather than synthesize a generic error. Without it the fallback still works
    // and every existing before-first-event test stays green, while the discarded WS dispatch
    // silently loses the one piece of evidence that says "the header watchdog ended it".
    setStateForTests({ responseHeaderTimeout: 0.02 })
    const transports: Array<string> = []
    const transport = createUpstreamResponsesTransport({ idleTimeoutMs: 5000 })
    setUpstreamWsConnectionFactoryForTests(() => silentRealConnection())

    const error = await transport.open(makeWire(), makeEnv(transports), compatDispatchOptionsForTests()).then(
      (r) => (r.kind === "fallback-before-first-event" ? r.error : undefined),
      (e: unknown) => e,
    )

    const chain: Array<string> = []
    for (let cursor: unknown = error; cursor instanceof Error; cursor = cursor.cause) chain.push(`${cursor.name}|${cursor.message}`)
    // Top frame must be the REQUEST wrapper, not the handshake one: that is the proof this
    // exercised the first-event watchdog rather than a handshake timeout (a probe found the
    // first version of this test silently taking the handshake path, where mutating the
    // watchdog changed nothing).
    expect(chain[0]).toBe("Error|Upstream WebSocket request aborted")
    expect(chain.some((frame) => frame.startsWith("TimeoutError|"))).toBe(true)
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

    await expect(transport.send(makeWire(), env, compatDispatchOptionsForTests({ signal: dispatchAbort.signal }))).rejects.not.toBeInstanceOf(
      UpstreamTransportFallbackError,
    )
    expect(wsSends).toBe(0)
    expect(httpCalls).toBe(0)
    expect(transports).toEqual(["upstream-ws"])
    expect(getUpstreamWsManager().consecutiveFallbacks("gpt-5.2")).toBe(0)
  })
})
