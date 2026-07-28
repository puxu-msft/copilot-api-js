import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestContext } from "~/lib/context/request"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  FormatCodec,
  PhysicalTransportResponse,
  PreparedRequest,
  RouteDecision,
  UpstreamDispatchLifecycle,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { createRequestContext } from "~/lib/context/request"
import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"

import { waitUntil } from "../helpers/wait-until"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function lifecycle(): UpstreamDispatchLifecycle {
  return {
    cancel() {},
    async dispose() {
      return { quiesced: true, connectionReusable: false }
    },
    quiesced: Promise.resolve(),
  }
}

function streamResponse(marker: string): PhysicalTransportResponse {
  const owner = lifecycle()
  const upstream: UpstreamStream & { lifecycle: UpstreamDispatchLifecycle } = {
    headers: new Headers({ "x-late-header": marker }),
    lifecycle: owner,
    frames: {
      async *[Symbol.asyncIterator]() {
        yield { data: marker }
      },
    },
  }
  return { kind: "stream", upstream, lifecycle: owner }
}

function makeEnv(ctx: RequestContext): RequestEnvelope {
  return {
    clientFormat: "anthropic",
    targetEndpoint: "/v1/messages",
    model: { id: "test-model" },
    stream: true,
    body: { messages: [] },
    view: {},
    prepareHints: {},
    ctx,
    with(patch: Partial<RequestEnvelope>) {
      return { ...this, ...patch } as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

function makeCodec(env: RequestEnvelope): FormatCodec {
  return {
    format: "anthropic",
    parse: () => env,
    translateOut: (current) => current,
    prepareWire: (current) => ({ url: current.targetEndpoint ?? "/v1/messages", headers: new Headers(), body: current.body, stream: true }),
    renderResponse: (frame) => frame,
    renderResponseNonStreaming: (upstream) => upstream,
    formatError: () => ({ data: "{}" }),
    createResponseAccumulator: () => ({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" }),
  }
}

function makeDriver(input: { env: RequestEnvelope; open: (wire: PreparedRequest) => Promise<PhysicalTransportResponse> }) {
  const deps: DriverDeps = {
    codec: makeCodec(input.env),
    transport: {
      send: async () => {
        throw new Error("send must not be called when the physical transport open seam is supplied")
      },
      open: async (wire) => input.open(wire),
    },
    decideRoute: () => ({ kind: "passthrough", endpoint: "/v1/messages" }) as RouteDecision,
    strategies: [],
    maxRetries: 0,
    maxLearningRetries: 0,
  }
  return createPipelineDriver(deps)
}

async function runLateHeaderAfterSeal(settle: (ctx: RequestContext) => void): Promise<{
  ctx: RequestContext
  requestError: unknown
  unhandled: ReadonlyArray<unknown>
}> {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  ctx.setOriginalRequest({ model: "test-model", messages: [], stream: true, payload: { messages: [] } })
  ctx.finalizeModelOperationDelivery()
  // Reproduce the orphan-owner topology from the crash report: the logical owner can seal while
  // PhysicalTransport.open() is still pending. Current production runRequest also tracks the exchange
  // in operationScope; suppress that newer structural join here so this regression directly locks the
  // recordOpened/setDispatchTiming defense instead of passing only because another layer delays seal.
  const driverCtx = new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === "trackOperationBody") return () => {}
      return Reflect.get(target, property, receiver)
    },
  })
  const lateOpen = deferred<PhysicalTransportResponse>()
  const driver = makeDriver({ env: makeEnv(driverCtx), open: async () => lateOpen.promise })
  const request = driver.runRequest({ body: { messages: [] }, headers: new Headers() })
  const unhandled: Array<unknown> = []
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)
  try {
    await waitUntil(() => ctx.modelOperationSnapshot.dispatches.length === 1, { label: "dispatch to enter deferred physical open" })

    settle(ctx)
    await ctx.whenModelOperationFinalized()
    const headersBeforeLateOpen = ctx.httpHeaders?.outboundResponse
    const terminalRecord = ctx.modelOperationTerminalRecord
    if (!terminalRecord) throw new Error("expected canonical observability to be sealed before late open")
    const terminalSequence = terminalRecord.lastSequence

    lateOpen.resolve(streamResponse("arrived-after-seal"))
    let requestError: unknown
    try {
      await request
    } catch (error) {
      requestError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(ctx.httpHeaders?.outboundResponse).toEqual(headersBeforeLateOpen)
    expect(ctx.modelOperationSnapshot.lastSequence).toBe(terminalSequence)
    expect(ctx.modelOperationSnapshot.dispatches[0]?.timing?.upstreamHeadersAt).toBeUndefined()
    return { ctx, requestError, unhandled }
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
}

describe("pre-content late-open seal race", () => {
  test("an open that arrives before seal records response headers and upstreamHeadersAt", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "test-model", messages: [], stream: true, payload: { messages: [] } })
    const driver = makeDriver({ env: makeEnv(ctx), open: async () => streamResponse("arrived-before-seal") })

    const result = await driver.runRequest({ body: { messages: [] }, headers: new Headers() })

    expect(result.ok).toBe(true)
    expect(ctx.httpHeaders?.outboundResponse).toEqual({ "x-late-header": "arrived-before-seal" })
    expect(ctx.modelOperationSnapshot.dispatches[0]?.timing?.upstreamHeadersAt).toBeNumber()
  })

  test("the request timing setter independently ignores a late best-effort observation after seal", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    const candidate = ctx.beginGenerationCandidate({ role: "primary" })
    const dispatch = ctx.beginGenerationDispatch({ candidate })
    ctx.settleGenerationDispatch(dispatch, { verdict: "committed" })
    ctx.settleGenerationCandidate(candidate, { verdict: "winner" })
    ctx.complete({ success: true, model: "test-model", usage: { input_tokens: 0, output_tokens: 0 }, content: "done" })
    ctx.finalizeModelOperationDelivery()
    const terminal = await ctx.whenModelOperationFinalized()

    expect(() => ctx.setGenerationDispatchTimingEpoch(dispatch, "upstreamHeadersAt", 2, "once")).not.toThrow()
    expect(ctx.modelOperationSnapshot).toBe(terminal)
  })

  test("the timing recorder independently ignores late best-effort observations but still rejects semantic writes after seal", () => {
    const recorder = createModelOperationRecorder({ identity: { operationId: "late-timing", kind: "generation", createdAt: 1 } })
    const candidate = recorder.beginCandidate({ role: "primary" })
    const dispatch = recorder.beginDispatch({ candidate })
    recorder.settleDispatch(dispatch, { verdict: "committed" })
    recorder.settleCandidate(candidate, { verdict: "winner" })
    const terminal = recorder.commitTerminal({ outcome: "completed", winnerCandidate: candidate, committedDispatch: dispatch })

    expect(() => recorder.setDispatchTiming(dispatch, "upstreamHeadersAt", 2, "once")).not.toThrow()
    expect(recorder.snapshot()).toBe(terminal)
    expect(() => recorder.recordRouting({ requestedModel: "semantic-write-after-seal" })).toThrow(/terminal.*committed/i)
  })

  test("deadline-style failure discards a deferred header that arrives after terminal seal", async () => {
    const result = await runLateHeaderAfterSeal((ctx) => {
      ctx.cancel("request_deadline")
      ctx.fail("test-model", new Error("request_deadline"), undefined, { attribution: { category: "timeout", code: "request_deadline" } })
    })

    expect(result.requestError).toBeDefined()
    expect(result.unhandled).toHaveLength(0)
  })

  test("reaper-style failure discards a deferred header that arrives after terminal seal", async () => {
    const result = await runLateHeaderAfterSeal((ctx) => {
      ctx.reapInFlight()
      ctx.fail("test-model", new Error("stale context reaper"), undefined, { attribution: { category: "reaper", code: "stale-context-reaper" } })
    })

    expect(result.requestError).toBeDefined()
    expect(result.unhandled).toHaveLength(0)
  })

  test("client abort discards a deferred header that arrives after terminal seal", async () => {
    const result = await runLateHeaderAfterSeal((ctx) => {
      ctx.cancel("client-disconnected")
      ctx.abort("test-model")
    })

    expect(result.requestError).toBeDefined()
    expect(result.unhandled).toHaveLength(0)
  })
})
