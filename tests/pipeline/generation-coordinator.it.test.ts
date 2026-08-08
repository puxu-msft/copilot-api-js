import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  CandidateHandle,
  CandidateRole,
  CandidateVerdict,
  DispatchHandle,
  DispatchVerdict,
} from "~/lib/context/model-operation-record"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { CandidateRuntime } from "~/lib/pipeline/generation/candidate"
import type { DispatchRecordingPort } from "~/lib/pipeline/generation/dispatch-scheduler"
import type {
  //
  PhysicalTransportResponse,
  PreparedRequest,
  UpstreamDispatchLifecycle,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { createCandidateRuntime } from "~/lib/pipeline/generation/candidate"
import { createGenerationCoordinator } from "~/lib/pipeline/generation/coordinator"
import { createDispatchScheduler } from "~/lib/pipeline/generation/dispatch-scheduler"
import { createGenerationBudget } from "~/lib/pipeline/generation/generation-budget"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

interface CandidateRow {
  role: CandidateRole
  parentCandidate?: CandidateHandle
  verdict?: CandidateVerdict
}

interface DispatchRow {
  candidate: CandidateHandle
  reason: string
  verdict?: DispatchVerdict
  settlementReason?: string
  settlementError?: unknown
  retryNextStrategy?: string
}

function createRecording(options?: { throwCandidateSettlementOnce?: unknown }) {
  let candidateSequence = 0
  let dispatchSequence = 0
  let candidateSettlementThrowPending = options?.throwCandidateSettlementOnce !== undefined
  const candidates = new Map<CandidateHandle, CandidateRow>()
  const dispatches = new Map<DispatchHandle, DispatchRow>()
  const port: DispatchRecordingPort = {
    beginCandidate(input) {
      const handle = `candidate-${++candidateSequence}` as CandidateHandle
      candidates.set(handle, { role: input.role, ...(input.parentCandidate && { parentCandidate: input.parentCandidate }) })
      return handle
    },
    settleCandidate(handle, input) {
      if (candidateSettlementThrowPending) {
        candidateSettlementThrowPending = false
        throw options?.throwCandidateSettlementOnce
      }
      candidates.get(handle)!.verdict = input.verdict
    },
    beginDispatch(input) {
      const handle = `dispatch-${++dispatchSequence}` as DispatchHandle
      dispatches.set(handle, { candidate: input.candidate, reason: input.reason })
      return handle
    },
    recordAdmission() {},
    recordOpened() {},
    settleDispatch(handle, input) {
      const dispatch = dispatches.get(handle)!
      dispatch.verdict = input.verdict
      dispatch.settlementReason = input.reason
      dispatch.settlementError = input.error
      dispatch.retryNextStrategy = input.retryNextStrategy
    },
  }
  return { port, candidates, dispatches }
}

function envelope(label: string): RequestEnvelope {
  return {
    clientFormat: "openai-cc",
    targetEndpoint: "/chat/completions",
    model: { id: "model" },
    stream: true,
    body: { label },
    view: { messages: [], tools: [], system: undefined, summary: { messageCount: 0, hasTools: false, hasThinking: false, hasImages: false } },
    prepareHints: {},
    ctx: {},
    with(patch: Partial<RequestEnvelope>) {
      return { ...this, ...patch } as RequestEnvelope
    },
  } as unknown as RequestEnvelope
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
    headers: new Headers({ "x-marker": marker }),
    lifecycle: owner,
    frames: {
      async *[Symbol.asyncIterator]() {
        yield { data: marker }
      },
    },
  }
  return { kind: "stream", upstream, lifecycle: owner }
}

function candidateFactory(input: {
  recording: DispatchRecordingPort
  opens: Array<string>
  processors: Array<symbol>
}): (candidate: { role: CandidateRole; parentCandidate?: CandidateHandle; env: RequestEnvelope }) => CandidateRuntime<{ identity: symbol }> {
  return ({ role, parentCandidate, env }) => {
    const scheduler = createDispatchScheduler({
      prepareWire: (current) => ({ url: "https://upstream.test", headers: new Headers(), body: current.body, stream: true }),
      open: async (wire: PreparedRequest) => {
        const label = (wire.body as { label: string }).label
        input.opens.push(label)
        return streamResponse(label)
      },
      admission: {
        acquire: async () => ({ admittedAt: Date.now(), queueWaitMs: 0 }),
        observe: () => ({ kind: "complete" as const }),
        rejectAll() {},
      },
      recording: input.recording,
      decideRetry: async () => ({ kind: "fail" }),
    })
    return createCandidateRuntime({
      role,
      ...(parentCandidate && { parentCandidate }),
      env,
      recording: input.recording,
      scheduler,
      createProcessor: () => {
        const identity = Symbol("processor")
        input.processors.push(identity)
        return { identity }
      },
    })
  }
}

describe("P6-T2 generation coordinator", () => {
  useIsolatedRuntime()

  test("primary success creates one candidate, one dispatch, and exactly one processor", async () => {
    const recording = createRecording()
    const opens: Array<string> = []
    const processors: Array<symbol> = []
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      createCandidate: candidateFactory({ recording: recording.port, opens, processors }),
    })

    const primary = await coordinator.runPrimary()

    expect(primary.role).toBe("primary")
    expect(primary.processor.identity).toBe(processors[0])
    expect(opens).toEqual(["primary"])
    expect(recording.candidates.size).toBe(1)
    expect(recording.dispatches.size).toBe(1)
  })

  test("buffered recovery is a child candidate and preserves the coordinator delivery identity", async () => {
    const recording = createRecording()
    const opens: Array<string> = []
    const processors: Array<symbol> = []
    const deliveryIdentity = Symbol("delivery")
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      deliveryIdentity,
      createCandidate: candidateFactory({ recording: recording.port, opens, processors }),
    })
    const primary = await coordinator.runPrimary()

    const recovery = await coordinator.runRecovery(primary, "truncated", envelope("recovery"))

    expect(primary.deliveryIdentity).toBe(deliveryIdentity)
    expect(recovery.deliveryIdentity).toBe(deliveryIdentity)
    expect(recovery.role).toBe("recovery")
    expect(recording.candidates.get(recovery.candidate)?.parentCandidate).toBe(primary.candidate)
    expect(recording.candidates.get(primary.candidate)?.verdict).toBe("failed")
    expect(recording.dispatches.get(primary.dispatch)).toMatchObject({ verdict: "discarded", retryNextStrategy: "buffered-retry" })
    expect(processors).toHaveLength(2)
    expect(processors[0]).not.toBe(processors[1])
  })

  test("recovery disposes an unread ready parent with one explicit discarded settlement", async () => {
    const recording = createRecording()
    const opens: Array<string> = []
    const processors: Array<symbol> = []
    let disposeCalls = 0
    let cancelCalls = 0
    let resolveQuiesced!: () => void
    const quiesced = new Promise<void>((resolve) => (resolveQuiesced = resolve))
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      createCandidate: ({ role, parentCandidate, env }) => {
        const scheduler = createDispatchScheduler({
          prepareWire: (current) => ({ url: "https://upstream.test", headers: new Headers(), body: current.body, stream: true }),
          open: async (wire) => {
            const label = (wire.body as { label: string }).label
            opens.push(label)
            if (label !== "primary") return streamResponse(label)
            const owner: UpstreamDispatchLifecycle = {
              cancel() {
                cancelCalls++
                resolveQuiesced()
              },
              async dispose() {
                disposeCalls++
                return { quiesced: true, connectionReusable: false }
              },
              quiesced,
            }
            return {
              kind: "stream",
              lifecycle: owner,
              upstream: { headers: new Headers({ "x-marker": label }), lifecycle: owner, frames: { async *[Symbol.asyncIterator]() {} } },
            }
          },
          admission: { acquire: async () => ({ admittedAt: Date.now(), queueWaitMs: 0 }), observe: () => ({ kind: "complete" as const }), rejectAll() {} },
          recording: recording.port,
          decideRetry: async () => ({ kind: "fail" }),
        })
        return createCandidateRuntime({
          role,
          ...(parentCandidate && { parentCandidate }),
          env,
          recording: recording.port,
          scheduler,
          createProcessor: () => {
            const identity = Symbol("processor")
            processors.push(identity)
            return { identity }
          },
        })
      },
    })
    const primary = await coordinator.runPrimary()
    const recovery = await coordinator.runRecovery(primary, "pre-wire-owner", envelope("recovery"), "precontent-recovery")

    expect(recovery.role).toBe("recovery")
    expect(opens).toEqual(["primary", "recovery"])
    expect({ cancelCalls, disposeCalls }).toEqual({ cancelCalls: 1, disposeCalls: 1 })
    expect(recording.dispatches.get(primary.dispatch)).toMatchObject({
      verdict: "discarded",
      settlementReason: "pre-wire-owner",
      retryNextStrategy: "precontent-recovery",
    })
    expect(recording.candidates.get(primary.candidate)?.verdict).toBe("failed")
  })

  test("recovery disposal failure remains a discarded primary and rejects before opening recovery", async () => {
    const recording = createRecording()
    const opens: Array<string> = []
    const processors: Array<symbol> = []
    const disposeError = new Error("unread parent dispose failed")
    const budget = createGenerationBudget({ maxActiveCandidates: 1, maxTotalCandidates: 2, maxActiveDispatches: 1, maxTotalDispatches: 2 })
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      createCandidate: ({ role, parentCandidate, env }) => {
        const scheduler = createDispatchScheduler({
          prepareWire: (current) => ({ url: "https://upstream.test", headers: new Headers(), body: current.body, stream: true }),
          open: async (wire) => {
            const label = (wire.body as { label: string }).label
            opens.push(label)
            const owner: UpstreamDispatchLifecycle = {
              cancel() {},
              async dispose() {
                throw disposeError
              },
              quiesced: Promise.resolve(),
            }
            return {
              kind: "stream",
              lifecycle: owner,
              upstream: { headers: new Headers({ "x-marker": label }), lifecycle: owner, frames: { async *[Symbol.asyncIterator]() {} } },
            }
          },
          admission: { acquire: async () => ({ admittedAt: Date.now(), queueWaitMs: 0 }), observe: () => ({ kind: "complete" as const }), rejectAll() {} },
          recording: recording.port,
          decideRetry: async () => ({ kind: "fail" }),
        })
        return createCandidateRuntime({
          role,
          ...(parentCandidate && { parentCandidate }),
          env,
          recording: recording.port,
          scheduler,
          createProcessor: () => {
            const identity = Symbol("processor")
            processors.push(identity)
            return { identity }
          },
        })
      },
      generationBudget: budget,
    })
    const primary = await coordinator.runPrimary()

    const rejection = await coordinator.runRecovery(primary, "dispose-failed", envelope("recovery"), "precontent-recovery").then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(rejection).toBeInstanceOf(AggregateError)
    expect((rejection as AggregateError).errors).toContain(disposeError)
    expect(opens).toEqual(["primary"])
    expect(recording.dispatches.get(primary.dispatch)).toMatchObject({
      verdict: "failed",
      settlementReason: "dispose-failed",
      settlementError: disposeError,
      retryNextStrategy: "precontent-recovery",
    })
    expect(recording.candidates.get(primary.candidate)?.verdict).toBe("failed")
    expect(budget.snapshot()).toMatchObject({ activeCandidates: 0, activeDispatches: 0 })
    await expect(coordinator.runRecovery(primary, "dispose-failed-again", envelope("recovery-again"), "precontent-recovery")).rejects.toThrow(
      "expected exactly one active ready dispatch, found 0",
    )
    expect(opens).toEqual(["primary"])
  })

  test.each([
    undefined,
    null,
    "recovery disposal failed",
    Number.NaN,
    new Error("recovery disposal failed"),
  ])("recovery rejects every cleanup failure value %# without opening a child", async (disposalError) => {
    const recording = createRecording()
    const opens: Array<string> = []
    const budget = createGenerationBudget({ maxActiveCandidates: 1, maxTotalCandidates: 2, maxActiveDispatches: 1, maxTotalDispatches: 2 })
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      createCandidate: ({ role, parentCandidate, env }) => {
        const handle = `${role}-${opens.length}` as CandidateHandle
        const runtime: CandidateRuntime<{ identity: symbol }> = {
          handle,
          role,
          async run() {
            opens.push(role)
            return {
              candidate: handle,
              dispatch: `${handle}-dispatch` as DispatchHandle,
              env,
              wire: { url: "https://upstream.test", headers: new Headers(), body: env.body, stream: true },
              dispatchedAtMonotonic: 0,
              upstream: { headers: new Headers(), lifecycle: lifecycle(), frames: { async *[Symbol.asyncIterator]() {} } },
              processor: { identity: Symbol(role) },
              async settleDispatch() {},
            }
          },
          async disposeReadyWithSettlement() {
            throw disposalError
          },
          async cancel() {},
          settle(input) {
            recording.candidates.set(handle, { role, ...(parentCandidate && { parentCandidate }), verdict: input.verdict })
          },
          recovery(reason) {
            return { role: "recovery", parentCandidate: handle, env, reason }
          },
        }
        return runtime
      },
      generationBudget: budget,
    })
    const primary = await coordinator.runPrimary()

    const outcome = await coordinator.runRecovery(primary, "dispose-failed", envelope("recovery")).then(
      () => ({ state: "resolved" as const }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    )

    expect(outcome.state).toBe("rejected")
    if (outcome.state !== "rejected") throw new Error("recovery unexpectedly resolved")
    if (disposalError instanceof Error) expect(outcome.error).toBe(disposalError)
    else expect(outcome.error).toMatchObject({ message: "Ready parent disposal failed", cause: disposalError })
    expect(opens).toEqual(["primary"])
    expect(recording.candidates.get(primary.candidate)?.verdict).toBe("failed")
    expect(budget.snapshot()).toMatchObject({ activeCandidates: 0, activeDispatches: 0 })
  })

  test.each([
    undefined,
    null,
    "unconsumed disposal failed",
    Number.NaN,
    new Error("unconsumed disposal failed"),
  ])("unconsumed disposal rejects every cleanup failure value %# and releases ownership", async (disposalError) => {
    const recording = createRecording()
    const budget = createGenerationBudget({ maxActiveCandidates: 1, maxTotalCandidates: 1, maxActiveDispatches: 1, maxTotalDispatches: 1 })
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      createCandidate: ({ role, env }) => {
        const handle = `${role}-0` as CandidateHandle
        return {
          handle,
          role,
          async run() {
            return {
              candidate: handle,
              dispatch: `${handle}-dispatch` as DispatchHandle,
              env,
              wire: { url: "https://upstream.test", headers: new Headers(), body: env.body, stream: true },
              dispatchedAtMonotonic: 0,
              upstream: { headers: new Headers(), lifecycle: lifecycle(), frames: { async *[Symbol.asyncIterator]() {} } },
              processor: { identity: Symbol(role) },
              async settleDispatch() {},
            }
          },
          async disposeReadyWithSettlement() {
            throw disposalError
          },
          async cancel() {},
          settle(input) {
            recording.candidates.set(handle, { role, verdict: input.verdict })
          },
          recovery(reason) {
            return { role: "recovery", parentCandidate: handle, env, reason }
          },
        } as CandidateRuntime<{ identity: symbol }>
      },
      generationBudget: budget,
    })
    const primary = await coordinator.runPrimary()

    const outcome = await coordinator.disposeUnconsumedReady(primary, { verdict: "discarded", reason: "unconsumed" }, "failed", "unconsumed-complete").then(
      () => ({ state: "resolved" as const }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    )

    expect(outcome.state).toBe("rejected")
    if (outcome.state !== "rejected") throw new Error("unconsumed disposal unexpectedly resolved")
    if (disposalError instanceof Error) expect(outcome.error).toBe(disposalError)
    else expect(outcome.error).toMatchObject({ message: "Unconsumed ready disposal failed", cause: disposalError })
    expect(recording.candidates.get(primary.candidate)?.verdict).toBe("failed")
    expect(budget.snapshot()).toMatchObject({ activeCandidates: 0, activeDispatches: 0 })
  })

  test("successful unconsumed disposal preserves the caller settlement", async () => {
    const recording = createRecording()
    const budget = createGenerationBudget({ maxActiveCandidates: 1, maxTotalCandidates: 1, maxActiveDispatches: 1, maxTotalDispatches: 1 })
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      createCandidate: ({ role, env }) => {
        const handle = `${role}-0` as CandidateHandle
        return {
          handle,
          role,
          async run() {
            return {
              candidate: handle,
              dispatch: `${handle}-dispatch` as DispatchHandle,
              env,
              wire: { url: "https://upstream.test", headers: new Headers(), body: env.body, stream: true },
              dispatchedAtMonotonic: 0,
              upstream: { headers: new Headers(), lifecycle: lifecycle(), frames: { async *[Symbol.asyncIterator]() {} } },
              processor: { identity: Symbol(role) },
              async settleDispatch() {},
            }
          },
          async disposeReadyWithSettlement() {},
          async cancel() {},
          settle(input) {
            recording.candidates.set(handle, { role, verdict: input.verdict })
          },
          recovery(reason) {
            return { role: "recovery", parentCandidate: handle, env, reason }
          },
        } as CandidateRuntime<{ identity: symbol }>
      },
      generationBudget: budget,
    })
    const primary = await coordinator.runPrimary()

    await expect(coordinator.disposeUnconsumedReady(primary, { verdict: "discarded", reason: "unconsumed" }, "failed", "caller-failed")).resolves.toBeUndefined()
    expect(recording.candidates.get(primary.candidate)?.verdict).toBe("failed")
    expect(budget.snapshot()).toMatchObject({ activeCandidates: 0, activeDispatches: 0 })
  })

  test("recovery propagates candidate recording failure after disposal and allows a public retry", async () => {
    const recordingError = new Error("candidate recording failed")
    const recording = createRecording({ throwCandidateSettlementOnce: recordingError })
    const opens: Array<string> = []
    const processors: Array<symbol> = []
    const budget = createGenerationBudget({ maxActiveCandidates: 1, maxTotalCandidates: 2, maxActiveDispatches: 1, maxTotalDispatches: 2 })
    const coordinator = createGenerationCoordinator({ env: envelope("primary"), createCandidate: candidateFactory({ recording: recording.port, opens, processors }), generationBudget: budget })
    const primary = await coordinator.runPrimary()

    await expect(coordinator.runRecovery(primary, "recording-failed", envelope("recovery"))).rejects.toBe(recordingError)
    expect(opens).toEqual(["primary"])
    expect(budget.snapshot()).toMatchObject({ activeCandidates: 0, activeDispatches: 0 })
    coordinator.completeCandidate(primary.candidate, "failed", "retry-recording")
    expect(recording.candidates.get(primary.candidate)?.verdict).toBe("failed")
  })

  test("consumed and unconsumed settlement propagate candidate recording failures", async () => {
    for (const mode of ["consumed", "unconsumed"] as const) {
      const recordingError = new Error(`${mode} candidate recording failed`)
      const recording = createRecording({ throwCandidateSettlementOnce: recordingError })
      const opens: Array<string> = []
      const processors: Array<symbol> = []
      const budget = createGenerationBudget({ maxActiveCandidates: 1, maxTotalCandidates: 1, maxActiveDispatches: 1, maxTotalDispatches: 1 })
      const coordinator = createGenerationCoordinator({ env: envelope("primary"), createCandidate: candidateFactory({ recording: recording.port, opens, processors }), generationBudget: budget })
      const primary = await coordinator.runPrimary()
      const task = mode === "consumed" ? coordinator.settleConsumedReady(primary, { verdict: "committed" }, "winner", "consumed") : coordinator.disposeUnconsumedReady(primary, { verdict: "discarded", reason: "unconsumed" }, "failed", "unconsumed")
      await expect(task).rejects.toBe(recordingError)
      expect(budget.snapshot()).toMatchObject({ activeCandidates: 0, activeDispatches: 0 })
      coordinator.completeCandidate(primary.candidate, "failed", "retry-recording")
      expect(recording.candidates.get(primary.candidate)?.verdict).toBe("failed")
    }
  })

  test("completeCandidate releases ownership when candidate recording rejects once", async () => {
    const recordingError = new Error("complete candidate recording failed")
    const recording = createRecording({ throwCandidateSettlementOnce: recordingError })
    const opens: Array<string> = []
    const processors: Array<symbol> = []
    const budget = createGenerationBudget({ maxActiveCandidates: 1, maxTotalCandidates: 1, maxActiveDispatches: 1, maxTotalDispatches: 1 })
    const coordinator = createGenerationCoordinator({ env: envelope("primary"), createCandidate: candidateFactory({ recording: recording.port, opens, processors }), generationBudget: budget })
    const primary = await coordinator.runPrimary()

    expect(() => coordinator.completeCandidate(primary.candidate, "failed", "first")).toThrow(recordingError)
    expect(budget.snapshot()).toMatchObject({ activeCandidates: 0, activeDispatches: 0 })
    expect(recording.candidates.get(primary.candidate)?.verdict).toBeUndefined()
    coordinator.completeCandidate(primary.candidate, "failed", "second")
    coordinator.completeCandidate(primary.candidate, "failed", "third")
    expect(recording.candidates.get(primary.candidate)?.verdict).toBe("failed")
  })

  test("concurrent recovery calls atomically consume one ready parent", async () => {
    const recording = createRecording()
    const opens: Array<string> = []
    const processors: Array<symbol> = []
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      createCandidate: candidateFactory({ recording: recording.port, opens, processors }),
    })
    const primary = await coordinator.runPrimary()

    const results = await Promise.allSettled([
      coordinator.runRecovery(primary, "first-recovery", envelope("recovery-1")),
      coordinator.runRecovery(primary, "second-recovery", envelope("recovery-2")),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    expect(rejection?.reason).toBeInstanceOf(Error)
    expect((rejection?.reason as Error).message).toContain("recovery parent is already being consumed")
    expect(opens).toEqual(["primary", "recovery-1"])
    expect(recording.dispatches.get(primary.dispatch)?.verdict).toBe("discarded")
    expect(recording.candidates.get(primary.candidate)?.verdict).toBe("failed")
  })

  test("recovery rejects an already consumed parent without opening another candidate", async () => {
    const recording = createRecording()
    const opens: Array<string> = []
    const processors: Array<symbol> = []
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      createCandidate: candidateFactory({ recording: recording.port, opens, processors }),
    })
    const primary = await coordinator.runPrimary()
    await primary.settleDispatch({ verdict: "discarded", reason: "already-consumed" })

    await expect(coordinator.runRecovery(primary, "already-consumed", envelope("recovery"))).rejects.toThrow(
      "expected exactly one active ready dispatch, found 0",
    )
    expect(opens).toEqual(["primary"])
    expect(recording.dispatches.get(primary.dispatch)?.verdict).toBe("discarded")
  })

  test("ready-state pre-content recovery can override the History next-strategy marker", async () => {
    const recording = createRecording()
    const opens: Array<string> = []
    const processors: Array<symbol> = []
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      createCandidate: candidateFactory({ recording: recording.port, opens, processors }),
    })
    const primary = await coordinator.runPrimary()

    await coordinator.runRecovery(primary, "transport-close", envelope("recovery"), "precontent-recovery")

    expect(recording.dispatches.get(primary.dispatch)).toMatchObject({
      verdict: "discarded",
      retryNextStrategy: "precontent-recovery",
    })
  })

  test("buffered continuation is a child candidate; parent settles `continued` (not failed) — partial delivery", async () => {
    const recording = createRecording()
    const opens: Array<string> = []
    const processors: Array<symbol> = []
    const deliveryIdentity = Symbol("delivery")
    const budget = createGenerationBudget({ maxActiveCandidates: 2, maxTotalCandidates: 2, maxActiveDispatches: 2, maxTotalDispatches: 2 })
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      deliveryIdentity,
      createCandidate: candidateFactory({ recording: recording.port, opens, processors }),
      generationBudget: budget,
    })
    const primary = await coordinator.runPrimary()

    const continuation = await coordinator.runContinuation(primary, "mid-stream-cut", envelope("continuation"))

    expect(continuation.deliveryIdentity).toBe(deliveryIdentity)
    expect(continuation.role).toBe("continuation")
    expect(recording.candidates.get(continuation.candidate)?.parentCandidate).toBe(primary.candidate)
    // The parent PARTIALLY delivered → settled `continued`, NOT `failed`/`discarded` (the honest verdict
    // for content already on the client wire; distinct from runRecovery's failed/discarded).
    expect(recording.candidates.get(primary.candidate)?.verdict).toBe("continued")
    expect(recording.dispatches.get(primary.dispatch)?.verdict).toBe("continued")
    expect(processors).toHaveLength(2)
    expect(processors[0]).not.toBe(processors[1])
    expect(opens).toEqual(["primary", "continuation"])
    expect(budget.snapshot()).toMatchObject({ activeCandidates: 1, activeDispatches: 0 })
    coordinator.completeCandidate(continuation.candidate, "failed", "cleanup-continuation")
    expect(budget.snapshot()).toMatchObject({ activeCandidates: 0, activeDispatches: 0 })
  })

  test("continuation dispatch settlement failure fails parent without opening child", async () => {
    const dispatchError = new Error("continuation dispatch failed")
    const recording = createRecording()
    const opens: Array<string> = []
    const processors: Array<symbol> = []
    const budget = createGenerationBudget({ maxActiveCandidates: 1, maxTotalCandidates: 2, maxActiveDispatches: 1, maxTotalDispatches: 2 })
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      createCandidate: candidateFactory({ recording: recording.port, opens, processors }),
      generationBudget: budget,
    })
    const primary = await coordinator.runPrimary()
    const failedParent = {
      ...primary,
      async settleDispatch() {
        throw dispatchError
      },
    }

    await expect(coordinator.runContinuation(failedParent, "dispatch-failed", envelope("continuation"))).rejects.toBe(dispatchError)
    expect(opens).toEqual(["primary"])
    expect(recording.candidates.get(primary.candidate)?.verdict).toBe("failed")
    expect(budget.snapshot()).toMatchObject({ activeCandidates: 0, activeDispatches: 0 })
  })

  test("continuation aggregates dispatch and candidate recording failures before a retry", async () => {
    const dispatchError = new Error("continuation dispatch failed")
    const recordingError = new Error("continuation recording failed")
    const recording = createRecording({ throwCandidateSettlementOnce: recordingError })
    const opens: Array<string> = []
    const processors: Array<symbol> = []
    const budget = createGenerationBudget({ maxActiveCandidates: 1, maxTotalCandidates: 2, maxActiveDispatches: 1, maxTotalDispatches: 2 })
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      createCandidate: candidateFactory({ recording: recording.port, opens, processors }),
      generationBudget: budget,
    })
    const primary = await coordinator.runPrimary()
    const failedParent = {
      ...primary,
      async settleDispatch() {
        throw dispatchError
      },
    }

    const error = await coordinator.runContinuation(failedParent, "dispatch-failed", envelope("continuation")).then(
      () => undefined,
      (rejection: unknown) => rejection,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([dispatchError, recordingError])
    expect(opens).toEqual(["primary"])
    expect(budget.snapshot()).toMatchObject({ activeCandidates: 0, activeDispatches: 0 })
    coordinator.completeCandidate(primary.candidate, "failed", "retry-recording")
    expect(recording.candidates.get(primary.candidate)?.verdict).toBe("failed")
  })

  test("chained buffered recovery advances the parent while preserving one delivery identity", async () => {
    const recording = createRecording()
    const opens: Array<string> = []
    const processors: Array<symbol> = []
    const deliveryIdentity = Symbol("delivery")
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      deliveryIdentity,
      createCandidate: candidateFactory({ recording: recording.port, opens, processors }),
    })
    const primary = await coordinator.runPrimary()
    const recovery1 = await coordinator.runRecovery(primary, "truncated-1", envelope("recovery-1"))

    const recovery2 = await coordinator.runRecovery(recovery1, "truncated-2", envelope("recovery-2"))

    expect(recovery2.deliveryIdentity).toBe(deliveryIdentity)
    expect(recording.candidates.get(recovery1.candidate)?.parentCandidate).toBe(primary.candidate)
    expect(recording.candidates.get(recovery2.candidate)?.parentCandidate).toBe(recovery1.candidate)
    expect(recording.candidates.get(primary.candidate)?.verdict).toBe("failed")
    expect(recording.dispatches.get(primary.dispatch)?.verdict).toBe("discarded")
    expect(recording.candidates.get(recovery1.candidate)?.verdict).toBe("failed")
    expect(recording.dispatches.get(recovery1.dispatch)?.verdict).toBe("discarded")
    expect(processors).toHaveLength(3)
    expect(new Set(processors).size).toBe(3)
  })

  test("request cancellation reaches the active primary candidate", async () => {
    const recording = createRecording()
    let acquireStarted!: () => void
    const started = new Promise<void>((resolve) => (acquireStarted = resolve))
    const coordinator = createGenerationCoordinator({
      env: envelope("cancel"),
      createCandidate: ({ role, parentCandidate, env }) => {
        const scheduler = createDispatchScheduler({
          prepareWire: () => ({ url: "https://upstream.test", headers: new Headers(), body: {}, stream: true }),
          open: async () => streamResponse("never"),
          admission: {
            acquire: ({ signal }) =>
              new Promise((_resolve, reject) => {
                acquireStarted()
                signal.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))), {
                  once: true,
                })
              }),
            observe: () => ({ kind: "complete" as const }),
            rejectAll() {},
          },
          recording: recording.port,
          decideRetry: async () => ({ kind: "fail" }),
        })
        return createCandidateRuntime({
          role,
          ...(parentCandidate && { parentCandidate }),
          env,
          recording: recording.port,
          scheduler,
          createProcessor: () => ({}),
        })
      },
    })
    const running = coordinator.runPrimary()
    await started

    await coordinator.cancel("request-deadline")

    await expect(running).rejects.toThrow("request-deadline")
    expect([...recording.candidates.values()].map((row) => row.verdict)).toEqual(["cancelled"])
    expect([...recording.dispatches.values()].map((row) => row.verdict)).toEqual(["cancelled"])
  })
})
