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
  DispatchHandle,
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

function recordingPort() {
  let candidateSequence = 0
  let dispatchSequence = 0
  const candidates = new Map<CandidateHandle, { role: CandidateRole; parentCandidate?: CandidateHandle; metadata?: { recoveryReason?: string } }>()
  const port: DispatchRecordingPort = {
    beginCandidate(input) {
      const handle = `candidate-${++candidateSequence}` as CandidateHandle
      candidates.set(handle, {
        role: input.role,
        ...(input.parentCandidate && { parentCandidate: input.parentCandidate }),
        ...(input.metadata !== undefined && { metadata: input.metadata }),
      })
      return handle
    },
    settleCandidate() {},
    beginDispatch() {
      return `dispatch-${++dispatchSequence}` as DispatchHandle
    },
    recordAdmission() {},
    recordOpened() {},
    settleDispatch() {},
  }
  return { candidates, port }
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

function candidateFactory(
  recording: DispatchRecordingPort,
): (input: {
  role: CandidateRole
  parentCandidate?: CandidateHandle
  metadata?: { recoveryReason?: string }
  env: RequestEnvelope
}) => CandidateRuntime<{ role: CandidateRole }> {
  return ({ role, parentCandidate, metadata, env }) => {
    const scheduler = createDispatchScheduler({
      prepareWire: (current) => ({ url: "https://upstream.test", headers: new Headers(), body: current.body, stream: true }),
      open: async (_wire: PreparedRequest) =>
        role === "primary" ? { kind: "failed-open", error: new Error("primary pre-ready failure"), lifecycle: lifecycle() } : streamResponse(role),
      admission: {
        acquire: async () => ({ admittedAt: Date.now(), queueWaitMs: 0 }),
        observe: () => ({ kind: "complete" as const }),
        rejectAll() {},
      },
      recording,
      decideRetry: async () => ({ kind: "fail" }),
    })
    return createCandidateRuntime({
      role,
      ...(parentCandidate && { parentCandidate }),
      ...(metadata !== undefined && { metadata }),
      env,
      recording,
      scheduler,
      createProcessor: () => ({ role }),
    })
  }
}

describe("pre-content recovery coordinator", () => {
  useIsolatedRuntime()

  test("runRecoveryFromPreReadyFailure starts a fresh parent-less recovery candidate", async () => {
    const recording = recordingPort()
    const coordinator = createGenerationCoordinator({ env: envelope("primary"), createCandidate: candidateFactory(recording.port) })

    await expect(coordinator.runPrimary()).rejects.toThrow("primary pre-ready failure")
    const recovery = await coordinator.runRecoveryFromPreReadyFailure("upstream-rst", envelope("recovery"))

    expect(recovery.role).toBe("recovery")
    expect(recording.candidates.get(recovery.candidate)).toMatchObject({ role: "recovery", metadata: { recoveryReason: "upstream-rst" } })
    expect(recording.candidates.get(recovery.candidate)).not.toHaveProperty("parentCandidate")
  })

  test("runRecoveryFromPreReadyFailure rejects a second recovery on the same coordinator", async () => {
    const recording = recordingPort()
    const coordinator = createGenerationCoordinator({ env: envelope("primary"), createCandidate: candidateFactory(recording.port) })

    await coordinator.runRecoveryFromPreReadyFailure("upstream-rst", envelope("recovery"))

    expect(() => coordinator.runRecoveryFromPreReadyFailure("second-rst", envelope("recovery-2"))).toThrow(/recovery from pre-ready failure already started/i)
  })

  test("runRecoveryFromPreReadyFailure consumes the primary generation budget", async () => {
    const recording = recordingPort()
    const budget = createGenerationBudget({ maxActiveCandidates: 1, maxTotalCandidates: 2, maxActiveDispatches: 2, maxTotalDispatches: 4 })
    const coordinator = createGenerationCoordinator({ env: envelope("primary"), createCandidate: candidateFactory(recording.port), generationBudget: budget })

    await expect(coordinator.runPrimary()).rejects.toThrow("primary pre-ready failure")
    expect(budget.snapshot()).toMatchObject({ activeCandidates: 0, totalCandidates: 1 })

    await coordinator.runRecoveryFromPreReadyFailure("upstream-rst", envelope("recovery"))

    expect(budget.snapshot()).toMatchObject({ activeCandidates: 1, totalCandidates: 2 })
  })
})
