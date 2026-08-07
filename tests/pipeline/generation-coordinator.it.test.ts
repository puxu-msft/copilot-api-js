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

function createRecording() {
  let candidateSequence = 0
  let dispatchSequence = 0
  const candidates = new Map<CandidateHandle, CandidateRow>()
  const dispatches = new Map<DispatchHandle, DispatchRow>()
  const port: DispatchRecordingPort = {
    beginCandidate(input) {
      const handle = `candidate-${++candidateSequence}` as CandidateHandle
      candidates.set(handle, { role: input.role, ...(input.parentCandidate && { parentCandidate: input.parentCandidate }) })
      return handle
    },
    settleCandidate(handle, input) {
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
    })
    const primary = await coordinator.runPrimary()

    await expect(coordinator.runRecovery(primary, "dispose-failed", envelope("recovery"), "precontent-recovery")).rejects.toThrow(
      "Ready dispatch disposal failed",
    )
    expect(opens).toEqual(["primary"])
    expect(recording.dispatches.get(primary.dispatch)).toMatchObject({
      verdict: "discarded",
      settlementReason: "dispose-failed",
      settlementError: disposeError,
      retryNextStrategy: "precontent-recovery",
    })
    expect(recording.candidates.get(primary.candidate)?.verdict).toBeUndefined()
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
    const coordinator = createGenerationCoordinator({
      env: envelope("primary"),
      deliveryIdentity,
      createCandidate: candidateFactory({ recording: recording.port, opens, processors }),
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
