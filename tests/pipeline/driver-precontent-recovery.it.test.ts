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

import {
  //
  makeArraySink,
  makeDeliverySseSink,
} from "~/lib/pipeline/client-sink"
import { getDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"
import { hasDeliveredSemanticContent } from "~/lib/pipeline/generation/semantic-content-gate"

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
    headers: new Headers({ "x-recovery-marker": marker }),
    lifecycle: owner,
    frames: {
      async *[Symbol.asyncIterator]() {
        yield { data: marker }
      },
    },
  }
  return { kind: "stream", upstream, lifecycle: owner }
}

function makeEnv(
  body: unknown,
  onRecordAttemptFailure: (input: { willRetry: boolean; nextStrategy?: string }) => void = () => {},
): RequestEnvelope {
  const ctx = {
    operationSignal: new AbortController().signal,
    beginAttempt() {},
    transition() {},
    setAttemptError() {},
    recordAttemptFailure: onRecordAttemptFailure,
    setSseEvents() {},
    setHttpHeaders() {},
    setAttemptEffectiveRequest() {},
    setAttemptWireRequest() {},
    setAttemptResponseHeaders() {},
    setAttemptTimingEpoch() {},
    setAttemptCacheControlStripped() {},
    recordFeature() {},
    addQueueWaitMs() {},
    selectGenerationWinner() {},
  } as unknown as RequestContext
  return {
    clientFormat: "anthropic",
    targetEndpoint: "/v1/messages",
    model: { id: "test-model" },
    stream: true,
    body,
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
  const codec = makeCodec(input.env)
  const deps: DriverDeps = {
    codec,
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

describe("driver pre-content recovery", () => {
  test("runRequest still rejects exactly as before when the primary dispatch never becomes ready", async () => {
    const primaryError = new Error("primary failed-open")
    const driver = makeDriver({
      env: makeEnv({ messages: [] }),
      open: async () => ({ kind: "failed-open", error: primaryError, lifecycle: lifecycle() }),
    })

    await expect(driver.runRequest({ body: {}, headers: new Headers() })).rejects.toBe(primaryError)
  })

  test("after a pre-ready primary failure, runPreContentRecovery starts a fresh recovery candidate that can open", async () => {
    let openCalls = 0
    const primaryError = new Error("primary failed-open")
    const driver = makeDriver({
      env: makeEnv({ messages: [] }),
      open: async () => {
        openCalls++
        return openCalls === 1 ? { kind: "failed-open", error: primaryError, lifecycle: lifecycle() } : streamResponse("recovery")
      },
    })

    await expect(driver.runRequest({ body: {}, headers: new Headers() })).rejects.toBe(primaryError)

    const result = await driver.runPreContentRecovery("upstream-rst")

    expect(result).toMatchObject({ ok: true, env: expect.any(Object) })
    if (result.ok) expect(result.upstream.headers.get("x-recovery-marker")).toBe("recovery")
    expect(openCalls).toBe(2)
  })

  test("runPreContentRecovery without a preceding pre-ready failure throws a programmer error", async () => {
    const driver = makeDriver({
      env: makeEnv({ messages: [] }),
      open: async () => streamResponse("primary"),
    })

    await expect(driver.runPreContentRecovery("upstream-rst")).rejects.toThrow(/without a preceding pre-ready failure/i)
  })

  test("runPreContentRecovery gates server-executed tools before dispatching a fresh attempt", async () => {
    let openCalls = 0
    const driver = makeDriver({
      env: makeEnv({ tools: [{ type: "web_search_20250305" }] }),
      open: async () => {
        openCalls++
        return { kind: "failed-open", error: new Error("primary failed-open"), lifecycle: lifecycle() }
      },
    })

    await expect(driver.runRequest({ body: {}, headers: new Headers() })).rejects.toThrow("primary failed-open")

    await expect(driver.runPreContentRecovery("upstream-rst")).rejects.toThrow(/server.*execution.*risk/i)
    expect(openCalls).toBe(1)
  })

  test("a ready upstream that stream-errors before semantic content dispatches response recovery with the precontent History strategy", async () => {
    let openCalls = 0
    const recordedFailures: Array<{ willRetry: boolean; nextStrategy?: string }> = []
    const primaryStreamError = new Error("primary stream reset before content")
    const driver = makeDriver({
      env: makeEnv({ messages: [] }, (failure) => recordedFailures.push(failure)),
      open: async () => {
        openCalls++
        if (openCalls === 1) {
          const owner = lifecycle()
          return {
            kind: "stream",
            lifecycle: owner,
            upstream: {
              headers: new Headers({ "x-recovery-marker": "primary" }),
              lifecycle: owner,
              frames: {
                [Symbol.asyncIterator]() {
                  return {
                    next: async () => Promise.reject(primaryStreamError),
                  }
                },
              },
            },
          }
        }
        return streamResponse("recovery")
      },
    })

    const primary = await driver.runRequest({ body: {}, headers: new Headers() })
    expect(primary.ok).toBe(true)
    if (!primary.ok) throw new Error("primary should become ready")
    const outcome = await driver.runResponseSink(primary.upstream, primary.env, makeArraySink().sink)
    expect(outcome).toMatchObject({ kind: "stream-error", error: primaryStreamError })

    const recovered = await driver.runResponseRecovery(primary.upstream, primary.env, "transport-close")

    expect(recovered).toMatchObject({ ok: true, env: expect.any(Object) })
    if (recovered.ok) expect(recovered.upstream.headers.get("x-recovery-marker")).toBe("recovery")
    expect(recordedFailures).toContainEqual({ willRetry: true, nextStrategy: "precontent-recovery" })
    expect(openCalls).toBe(2)
  })

  test("delivery gate prevents callers from selecting ready-state recovery after real content", async () => {
    const stream = { writeSSE: () => Promise.resolve() } as unknown as Parameters<typeof makeDeliverySseSink>[0]
    const sink = makeDeliverySseSink(stream, {
      isRealContentFrame: (frame) => frame.event === "content_block_delta",
    })
    const delivery = getDownstreamDeliverySession(sink)
    if (!delivery) throw new Error("delivery sink must expose its session")

    await sink.write({
      event: "content_block_delta",
      data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "delivered" } }),
    })

    // Caller-side prerequisite only: Task 4.2/4.3 owns the gate; the driver intentionally does not enforce it.
    expect(hasDeliveredSemanticContent(delivery)).toBe(true)
  })

  test("runResponseRecovery gates server-executed tools before dispatching a ready-state recovery", async () => {
    let openCalls = 0
    const driver = makeDriver({
      env: makeEnv({ tools: [{ type: "web_search_20250305" }] }),
      open: async () => {
        openCalls++
        return streamResponse(openCalls === 1 ? "primary" : "recovery")
      },
    })

    const primary = await driver.runRequest({ body: {}, headers: new Headers() })
    expect(primary.ok).toBe(true)
    if (!primary.ok) throw new Error("primary should become ready")

    await expect(driver.runResponseRecovery(primary.upstream, primary.env, "transport-close")).rejects.toThrow(/server.*execution.*risk/i)
    expect(openCalls).toBe(1)
  })
})
