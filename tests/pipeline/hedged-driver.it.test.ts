import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  FormatCodec,
  PhysicalTransport,
  PhysicalTransportResponse,
  PreparedRequest,
  UpstreamDispatchLifecycle,
  UpstreamFrame,
} from "~/lib/pipeline/types"

import {
  //
  createGenerationWireIndexAllocator,
  createGenerationWireState,
} from "~/lib/anthropic/keepalive-anchor"
import { createRequestContext } from "~/lib/context/request"
import { makeArraySink } from "~/lib/pipeline/client-sink"
import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { createCandidateResponseSession } from "~/lib/pipeline/generation/candidate-response-session"
import { createFrozenHedgePolicy } from "~/lib/pipeline/generation/hedge-policy"

function frames(label: string, signal: AbortSignal, stallPrimary: boolean, postBoundaryError?: Error): AsyncIterable<UpstreamFrame> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { event: "content_block_start", data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: label } }) }
      if (label === "primary" && stallPrimary) {
        await new Promise<void>((_resolve, reject) => {
          const abortError = () => (signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
          if (signal.aborted) reject(abortError())
          else signal.addEventListener("abort", () => reject(abortError()), { once: true })
        })
      }
      if (postBoundaryError) throw postBoundaryError
      yield { event: "content_block_delta", data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: label } }) }
      yield { event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) }
      yield { event: "message_stop", data: JSON.stringify({ type: "message_stop" }) }
    },
  }
}

function hedgePolicy(enabled: boolean, thresholdMs: number) {
  return createFrozenHedgePolicy({
    enabled,
    thresholdMs,
    maxSecondaryCandidates: 1,
    maxActiveCandidates: 2,
    maxTotalCandidates: 3,
    maxActiveDispatches: 2,
    maxTotalDispatches: 4,
    cleanupMarginMs: 0,
    responseHeaderTimeoutMs: 0,
    requestDeadlineAtMs: 0,
    expectedHedgeCompletionMs: 1,
  })
}

function driverHarness(input: {
  stallPrimary: boolean
  policy: ReturnType<typeof hedgePolicy>
  candidateOnRenderedFrame?: (frame: import("~/lib/pipeline/types").ClientFrame) => import("~/lib/pipeline/types").ClientFrame | undefined
  postBoundaryError?: Error
}) {
  let opens = 0
  let primaryCancelled = false
  const transport: PhysicalTransport = {
    async open(_wire, _env, options): Promise<PhysicalTransportResponse> {
      const label = opens++ === 0 ? "primary" : "secondary"
      const controller = new AbortController()
      options?.signal?.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true })
      const owner = lifecycle(controller, () => {
        if (label === "primary") primaryCancelled = true
      })
      return {
        kind: "stream",
        upstream: {
          headers: new Headers({ "x-candidate": label }),
          frames: frames(label, controller.signal, input.stallPrimary, input.postBoundaryError),
          lifecycle: owner,
        },
        lifecycle: owner,
      }
    },
  }
  const driver = createPipelineDriver({
    codec: codec(),
    transport: {
      ...transport,
      send: async () => {
        throw new Error("legacy send must not run")
      },
    },
    candidateResponseSessionFactory: (factoryInput) =>
      createCandidateResponseSession({
        ...factoryInput,
        createState: () => undefined,
        ...(input.candidateOnRenderedFrame && { onRenderedFrame: (_state, frame) => input.candidateOnRenderedFrame?.(frame) }),
        snapshot: () => ({}),
      }),
    strategies: [],
    maxRetries: 0,
    maxLearningRetries: 0,
    monotonicNow: () => 0,
    hedgePolicy: input.policy,
  })
  return { driver, opens: () => opens, primaryCancelled: () => primaryCancelled }
}

function lifecycle(controller: AbortController, onCancel: () => void): UpstreamDispatchLifecycle {
  let resolve!: () => void
  const quiesced = new Promise<void>((done) => (resolve = done))
  return {
    cancel(reason) {
      onCancel()
      if (!controller.signal.aborted) controller.abort(new Error(reason ?? "cancelled"))
      resolve()
    },
    async dispose(reason) {
      this.cancel(reason)
      return { quiesced: true, connectionReusable: false }
    },
    quiesced,
  }
}

function codec(): FormatCodec {
  return {
    format: "anthropic",
    parse() {
      const ctx = createRequestContext({ endpoint: "anthropic-messages" })
      const value = {
        clientFormat: "anthropic" as const,
        targetEndpoint: "/v1/messages" as const,
        model: { id: "claude-test" },
        stream: true,
        body: { model: "claude-test", stream: true },
        view: {} as never,
        prepareHints: {},
        ctx,
        with(patch: Partial<RequestEnvelope>) {
          return { ...this, ...patch } as RequestEnvelope
        },
      }
      return value as unknown as RequestEnvelope
    },
    translateOut: (env) => env,
    prepareWire: (env): PreparedRequest => ({ url: "/v1/messages", headers: new Headers(), body: env.body, stream: true }),
    renderResponse: (frame) => frame,
    renderResponseNonStreaming: (body) => body,
    formatError: () => ({ event: "error", data: "{}" }),
    createResponseAccumulator: () => ({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" }),
  }
}

describe("production driver hedged response", () => {
  test("starts a secondary at the threshold, forwards only its complete block, and cancels primary", async () => {
    const harness = driverHarness({ stallPrimary: true, policy: hedgePolicy(true, 0) })
    const { driver } = harness
    const request = await driver.runRequest({ body: {}, headers: new Headers() })
    if (!request.ok) throw new Error("unexpected rejection")
    const { sink: rawSink, frames: delivered } = makeArraySink()
    const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
    const delivery = createDownstreamDeliverySession({ sink: rawSink, wireState })

    const outcome = await driver.runResponseSink(request.upstream, request.env, delivery.clientSink, {
      onRenderedFrame: (frame) => frame,
      wireAllocationPort: delivery.allocationPort,
    })

    expect(outcome.kind).toBe("complete")
    if (outcome.kind !== "complete") throw new Error("unexpected hedge outcome")
    expect(outcome.finish).toMatchObject({ kind: "complete" })
    expect(harness.opens()).toBe(2)
    expect(harness.primaryCancelled()).toBe(true)
    expect(delivered.map((frame) => frame.data).join("\n")).toContain("secondary")
    expect(delivered.map((frame) => frame.data).join("\n")).not.toContain("primary")
    expect(request.env.ctx.modelOperationSnapshot.candidates.map((candidate) => candidate.role)).toEqual(["primary", "hedge"])
    expect(wireState.activeLeg?.kind).toBe("primary")
    const activeSource = wireState.activeLeg?.source
    expect(activeSource?.candidateId).toMatch(/^candidate:/)
    expect(activeSource?.dispatchId).toMatch(/^dispatch:/)
    if (!activeSource) throw new Error("hedge winner did not establish an active wire leg")
    const winnerDispatch = request.env.ctx.modelOperationSnapshot.dispatches.find((dispatch) => String(dispatch.handle) === activeSource.dispatchId)
    expect(String(winnerDispatch?.candidate)).toBe(activeSource.candidateId)
    expect(delivery.snapshot.winnerCandidateId).toBe(activeSource.candidateId)
  })

  test("a pre-boundary candidate transform failure is codec-render", async () => {
    const renderError = new Error("candidate pre-boundary render failure")
    const harness = driverHarness({
      stallPrimary: false,
      policy: hedgePolicy(true, 60_000),
      candidateOnRenderedFrame() {
        throw renderError
      },
    })
    const request = await harness.driver.runRequest({ body: {}, headers: new Headers() })
    if (!request.ok) throw new Error("unexpected rejection")

    const outcome = await harness.driver.runResponseSink(request.upstream, request.env, makeArraySink().sink)
    expect(outcome).toMatchObject({ kind: "stream-error", source: "codec-render", error: renderError })
    if (outcome.kind !== "stream-error") throw new Error("expected stream-error")
    expect(outcome.error).toBe(renderError)
    expect((outcome.error as Error).cause).not.toBeInstanceOf(Error)
  })

  test("a post-boundary candidate transform failure is codec-render", async () => {
    const renderError = new Error("candidate post-boundary render failure")
    const harness = driverHarness({
      stallPrimary: true,
      policy: hedgePolicy(true, 0),
      candidateOnRenderedFrame(frame) {
        if (frame.event === "message_stop") throw renderError
        return frame
      },
    })
    const request = await harness.driver.runRequest({ body: {}, headers: new Headers() })
    if (!request.ok) throw new Error("unexpected rejection")

    const outcome = await harness.driver.runResponseSink(request.upstream, request.env, makeArraySink().sink)
    expect(outcome).toMatchObject({ kind: "stream-error", source: "codec-render", error: renderError })
    if (outcome.kind !== "stream-error") throw new Error("expected stream-error")
    expect(outcome.error).toBe(renderError)
    expect((outcome.error as Error).cause).not.toBeInstanceOf(Error)
  })

  test("post-boundary upstream iterator failure is upstream-transport", async () => {
    const upstreamError = new Error("post-boundary upstream failure")
    const harness = driverHarness({ stallPrimary: false, policy: hedgePolicy(true, 60_000), postBoundaryError: upstreamError })
    const request = await harness.driver.runRequest({ body: {}, headers: new Headers() })
    if (!request.ok) throw new Error("unexpected rejection")

    await expect(harness.driver.runResponseSink(request.upstream, request.env, makeArraySink().sink)).resolves.toMatchObject({
      kind: "stream-error",
      source: "upstream-transport",
      error: upstreamError,
    })
  })

  test("a winner sink write failure is downstream-sink", async () => {
    const harness = driverHarness({ stallPrimary: true, policy: hedgePolicy(true, 0) })
    const request = await harness.driver.runRequest({ body: {}, headers: new Headers() })
    if (!request.ok) throw new Error("unexpected rejection")
    const { sink } = makeArraySink({ rejectAtFrame: 0 })

    await expect(harness.driver.runResponseSink(request.upstream, request.env, sink)).resolves.toMatchObject({
      kind: "stream-error",
      source: "downstream-sink",
    })
  })

  test("a complete primary before the threshold never starts a hedge", async () => {
    const harness = driverHarness({ stallPrimary: false, policy: hedgePolicy(true, 60_000) })
    const request = await harness.driver.runRequest({ body: {}, headers: new Headers() })
    if (!request.ok) throw new Error("unexpected rejection")
    const { sink, frames: delivered } = makeArraySink()

    const outcome = await harness.driver.runResponseSink(request.upstream, request.env, sink)

    expect(outcome.kind).toBe("complete")
    expect(harness.opens()).toBe(1)
    expect(harness.primaryCancelled()).toBe(false)
    expect(delivered.map((frame) => frame.data).join("\n")).toContain("primary")
    expect(request.env.ctx.modelOperationSnapshot.candidates.map((candidate) => candidate.role)).toEqual(["primary"])
  })

  test("an ineligible policy preserves the ordinary primary-only path", async () => {
    const harness = driverHarness({ stallPrimary: false, policy: hedgePolicy(false, 0) })
    const request = await harness.driver.runRequest({ body: {}, headers: new Headers() })
    if (!request.ok) throw new Error("unexpected rejection")
    const { sink, frames: delivered } = makeArraySink()

    const outcome = await harness.driver.runResponseSink(request.upstream, request.env, sink)

    expect(outcome.kind).toBe("complete")
    expect(harness.opens()).toBe(1)
    expect(delivered.map((frame) => frame.data).join("\n")).toContain("primary")
  })
})
