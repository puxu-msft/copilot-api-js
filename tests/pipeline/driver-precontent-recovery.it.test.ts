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
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"

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

function makeEnv(body: unknown): RequestEnvelope {
  const ctx = {
    operationSignal: new AbortController().signal,
    beginAttempt() {},
    transition() {},
    setAttemptError() {},
    recordAttemptFailure() {},
    setSseEvents() {},
    setHttpHeaders() {},
    setAttemptEffectiveRequest() {},
    setAttemptWireRequest() {},
    setAttemptResponseHeaders() {},
    setAttemptTimingEpoch() {},
    setAttemptCacheControlStripped() {},
    recordFeature() {},
    addQueueWaitMs() {},
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
})
