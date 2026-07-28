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

interface LateHeaderAfterSealHarness {
  ctx: RequestContext
  headersBeforeLateOpen: Record<string, string> | undefined
  lateOpen: ReturnType<typeof deferred<PhysicalTransportResponse>>
  request: Promise<unknown>
  stopUnhandledProbe(): void
  terminalSequence: number
  unhandled: Array<unknown>
}

async function arrangeLateHeaderAfterSeal(settle: (ctx: RequestContext) => void): Promise<LateHeaderAfterSealHarness> {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  ctx.setOriginalRequest({ model: "test-model", messages: [], stream: true, payload: { messages: [] } })
  ctx.finalizeModelOperationDelivery()
  // Production's primary exchange is registered in operationScope, so its finalizer cannot seal while
  // open() is pending. Suppress that structural join to exercise the still-reachable mock/legacy context,
  // candidate-discard/supersede, and future P4/P5 unregistered fresh-recovery topologies directly.
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

  await waitUntil(() => ctx.modelOperationSnapshot.dispatches.length === 1, { label: "dispatch to enter deferred physical open" })
  settle(ctx)
  await ctx.whenModelOperationFinalized()
  const terminalRecord = ctx.modelOperationTerminalRecord
  if (!terminalRecord) throw new Error("expected canonical observability to be sealed before late open")

  return {
    ctx,
    headersBeforeLateOpen: ctx.httpHeaders?.outboundResponse,
    lateOpen,
    request,
    stopUnhandledProbe: () => process.off("unhandledRejection", onUnhandled),
    terminalSequence: terminalRecord.lastSequence,
    unhandled,
  }
}

async function runLateHeaderAfterSeal(settle: (ctx: RequestContext) => void): Promise<{
  ctx: RequestContext
  requestError: unknown
  unhandled: ReadonlyArray<unknown>
}> {
  const harness = await arrangeLateHeaderAfterSeal(settle)
  try {
    harness.lateOpen.resolve(streamResponse("arrived-after-seal"))
    let requestError: unknown
    try {
      await harness.request
    } catch (error) {
      requestError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(harness.ctx.httpHeaders?.outboundResponse).toEqual(harness.headersBeforeLateOpen)
    expect(harness.ctx.modelOperationSnapshot.lastSequence).toBe(harness.terminalSequence)
    expect(harness.ctx.modelOperationSnapshot.dispatches[0]?.timing?.upstreamHeadersAt).toBeUndefined()
    return { ctx: harness.ctx, requestError, unhandled: harness.unhandled }
  } finally {
    harness.stopUnhandledProbe()
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

  test("the legacy attempt timing setter independently ignores a late observation after seal", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    ctx.beginAttempt({ strategy: "legacy" })
    ctx.complete({ success: true, model: "test-model", usage: { input_tokens: 0, output_tokens: 0 }, content: "done" })
    ctx.finalizeModelOperationDelivery()
    await ctx.whenModelOperationFinalized()

    ctx.setAttemptTimingEpoch?.("upstreamHeadersAt", 2, "once")

    expect(ctx.attempts[0]?.upstreamHeadersAt).toBeUndefined()
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

  test("an orphaned late-open request does not emit an unhandled rejection after terminal seal", async () => {
    const harness = await arrangeLateHeaderAfterSeal((ctx) => {
      // Seal observability without aborting the pending transport promise first. An early cancel would
      // produce an unrelated orphan AbortError before late open exercises the sealed observation path.
      ctx.fail("test-model", new Error("forced terminal seal"), undefined, { attribution: { category: "timeout", code: "forced-seal" } })
    })
    try {
      // Deliberately leave request without a live awaiter: attaching await/catch here would remove the
      // orphan topology whose rejected promise is amplified by the production unhandledRejection handler.
      harness.lateOpen.resolve(streamResponse("orphan-arrived-after-seal"))
      await new Promise((resolve) => setTimeout(resolve, 30))

      expect(harness.unhandled).toHaveLength(0)
    } finally {
      // The request is expected to resolve with the sealed guards present. Attach only after the probe
      // window so test cleanup cannot accidentally make the unhandled-rejection assertion false-green.
      await harness.request.catch(() => {})
      harness.stopUnhandledProbe()
    }
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
