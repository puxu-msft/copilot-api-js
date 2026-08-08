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
import type {
  //
  PhysicalTransportResponse,
  PreparedRequest,
  UpstreamDispatchLifecycle,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { UpstreamAdmissionController } from "~/lib/transport/admission-controller"

import { HTTPError } from "~/lib/error"
import { createCandidateRuntime } from "~/lib/pipeline/generation/candidate"
import {
  //
  createDispatchScheduler,
  type DispatchRecordingPort,
} from "~/lib/pipeline/generation/dispatch-scheduler"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

interface DispatchRow {
  candidate: CandidateHandle
  reason: string
  wire?: PreparedRequest
  admitted?: boolean
  openedKind?: PhysicalTransportResponse["kind"]
  verdict?: DispatchVerdict
  settlementReason?: string
  settlementError?: unknown
}

function recordingPort(options?: { throwSettlementOnce?: unknown }) {
  let candidateSequence = 0
  let dispatchSequence = 0
  let settlementThrowPending = options?.throwSettlementOnce !== undefined
  const candidates = new Map<CandidateHandle, { role: CandidateRole; parentCandidate?: CandidateHandle; verdict?: CandidateVerdict; reason?: string }>()
  const dispatches = new Map<DispatchHandle, DispatchRow>()
  const port: DispatchRecordingPort = {
    beginCandidate(input) {
      const handle = `candidate-${++candidateSequence}` as CandidateHandle
      candidates.set(handle, { role: input.role, ...(input.parentCandidate && { parentCandidate: input.parentCandidate }) })
      return handle
    },
    settleCandidate(handle, input) {
      Object.assign(candidates.get(handle)!, input)
    },
    beginDispatch(input) {
      const handle = `dispatch-${++dispatchSequence}` as DispatchHandle
      dispatches.set(handle, { candidate: input.candidate, reason: input.reason, wire: input.wire })
      return handle
    },
    recordAdmission(handle) {
      dispatches.get(handle)!.admitted = true
    },
    recordOpened(handle, response) {
      dispatches.get(handle)!.openedKind = response.kind
    },
    settleDispatch(handle, input) {
      if (settlementThrowPending) {
        settlementThrowPending = false
        throw options?.throwSettlementOnce
      }
      const row = dispatches.get(handle)!
      row.verdict = input.verdict
      row.settlementReason = input.reason
      row.settlementError = input.error
    },
  }
  return { port, candidates, dispatches }
}

function envelope(label: string): RequestEnvelope {
  const env = {
    clientFormat: "openai-responses",
    targetEndpoint: "/responses",
    model: { id: "model" },
    stream: true,
    body: { label },
    view: { messages: [], tools: [], system: undefined, summary: { messageCount: 0, hasTools: false, hasThinking: false, hasImages: false } },
    prepareHints: {},
    ctx: {},
    with(patch: Partial<RequestEnvelope>) {
      return { ...this, ...patch } as RequestEnvelope
    },
  }
  return env as unknown as RequestEnvelope
}

function settledLifecycle(log: Array<string>, name: string): UpstreamDispatchLifecycle {
  return {
    cancel(reason) {
      log.push(`${name}:cancel:${reason ?? ""}`)
    },
    async dispose(reason) {
      log.push(`${name}:dispose:${reason ?? ""}`)
      return { quiesced: true, connectionReusable: false }
    },
    quiesced: Promise.resolve(),
  }
}

function ownedLifecycle(log: Array<string>, name: string): UpstreamDispatchLifecycle {
  let resolveQuiesced!: () => void
  const quiesced = new Promise<void>((resolve) => (resolveQuiesced = resolve))
  return {
    cancel(reason) {
      log.push(`${name}:cancel:${reason ?? ""}`)
    },
    async dispose(reason) {
      log.push(`${name}:dispose:${reason ?? ""}`)
      resolveQuiesced()
      return { quiesced: true, connectionReusable: false }
    },
    quiesced,
  }
}

function streamResponse(lifecycle: UpstreamDispatchLifecycle, marker: string): PhysicalTransportResponse {
  const upstream: UpstreamStream & { lifecycle: UpstreamDispatchLifecycle } = {
    headers: new Headers({ "x-marker": marker }),
    lifecycle,
    frames: {
      async *[Symbol.asyncIterator]() {
        yield { data: marker }
      },
    },
  }
  return { kind: "stream", upstream, lifecycle }
}

function immediateAdmission() {
  return {
    acquire: async (_input: Parameters<UpstreamAdmissionController["acquire"]>[0]) => ({ admittedAt: Date.now(), queueWaitMs: 0 }),
    observe: (input: { rateLimited?: boolean }) =>
      input.rateLimited ? { kind: "retry" as const, retryAfterMs: 0, retryAt: Date.now() } : { kind: "complete" as const },
    rejectAll() {},
  }
}

function runtime(input: {
  env: RequestEnvelope
  recording: DispatchRecordingPort
  open: (wire: PreparedRequest, env: RequestEnvelope, options: { forceHttp?: boolean; signal?: AbortSignal }) => Promise<PhysicalTransportResponse>
  admission?: UpstreamAdmissionController
  decideRetry?: Parameters<typeof createDispatchScheduler>[0]["decideRetry"]
  maxDispatches?: number
}) {
  const scheduler = createDispatchScheduler({
    prepareWire: (env) => ({ url: "https://upstream.test", headers: new Headers(), body: env.body, stream: env.stream }),
    open: input.open,
    admission: input.admission ?? immediateAdmission(),
    recording: input.recording,
    decideRetry: input.decideRetry ?? (async () => ({ kind: "fail" as const })),
    ...(input.maxDispatches !== undefined && { maxDispatches: input.maxDispatches }),
  })
  return createCandidateRuntime({
    role: "primary",
    env: input.env,
    recording: input.recording,
    scheduler,
    createProcessor: ({ dispatch }) => ({ dispatch, identity: Symbol("processor") }),
  })
}

describe("P6-T1 candidate dispatch runtime", () => {
  useIsolatedRuntime()

  test("WS fallback quiesces the failed dispatch and opens a force-HTTP dispatch in the same candidate", async () => {
    const recording = recordingPort()
    const log: Array<string> = []
    const options: Array<boolean | undefined> = []
    let opens = 0
    const candidate = runtime({
      env: envelope("ws-fallback"),
      recording: recording.port,
      open: async (_wire, _env, option) => {
        options.push(option.forceHttp)
        if (opens++ === 0) return { kind: "fallback-before-first-event", error: new Error("ws failed"), lifecycle: settledLifecycle(log, "ws") }
        return streamResponse(ownedLifecycle(log, "http"), "http-success")
      },
    })

    const ready = await candidate.run()

    expect(options).toEqual([undefined, true])
    expect([...recording.dispatches.values()].map((row) => ({ candidate: row.candidate, reason: row.reason, verdict: row.verdict }))).toEqual([
      { candidate: candidate.handle, reason: "initial", verdict: "discarded" },
      { candidate: candidate.handle, reason: "ws-fallback", verdict: undefined },
    ])
    expect(log).toContain("ws:dispose:ws-fallback")
    expect(ready.upstream.headers.get("x-marker")).toBe("http-success")
    await candidate.cancel("test-cleanup")
  })

  test("cleanup rejection releases the ready dispatch while preserving all phase errors", async () => {
    const recording = recordingPort()
    const upstreamError = new Error("upstream failure")
    const cancelError = new Error("cancel cleanup failed")
    const disposeError = new Error("dispose cleanup failed")
    const quiesceError = new Error("quiesce cleanup failed")
    const quiesced = Promise.reject(quiesceError)
    void quiesced.catch(() => {})
    const lifecycle: UpstreamDispatchLifecycle = {
      cancel() {
        throw cancelError
      },
      async dispose() {
        throw disposeError
      },
      quiesced,
    }
    const candidate = runtime({
      env: envelope("cleanup-rejection"),
      recording: recording.port,
      open: async () => streamResponse(lifecycle, "cleanup-rejection"),
    })

    const ready = await candidate.run()
    const rejection = await candidate.disposeReadyWithSettlement({ verdict: "discarded", reason: "cleanup-rejection", error: upstreamError }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(rejection).toBeInstanceOf(AggregateError)
    expect((rejection as AggregateError).errors[0]).toBeInstanceOf(AggregateError)
    expect(((rejection as AggregateError).errors[0] as AggregateError).errors).toEqual([cancelError, disposeError, quiesceError])
    // Propagation deliberately contains cleanup errors only: `settlement.error` is diagnostic input, not a cleanup failure.
    await expect(ready.settleDispatch({ verdict: "failed", reason: "after-cleanup" })).resolves.toBeUndefined()
    expect(recording.dispatches.get(ready.dispatch)).toMatchObject({ verdict: "failed", settlementReason: "cleanup-rejection" })
    expect((recording.dispatches.get(ready.dispatch)?.settlementError as AggregateError).errors).toEqual([upstreamError, cancelError, disposeError, quiesceError])
    expect(recording.candidates.get(candidate.handle)?.verdict).toBeUndefined()
  })

  test("undefined cleanup rejection fails settlement and releases the active dispatch", async () => {
    const recording = recordingPort()
    const quiesced = Promise.reject(undefined)
    void quiesced.catch(() => {})
    const lifecycle: UpstreamDispatchLifecycle = {
      cancel() {},
      async dispose() {
        throw undefined
      },
      quiesced,
    }
    const candidate = runtime({
      env: envelope("undefined-cleanup-rejection"),
      recording: recording.port,
      open: async () => streamResponse(lifecycle, "undefined-cleanup-rejection"),
    })

    const ready = await candidate.run()
    const outcome = await candidate.disposeReadyWithSettlement({ verdict: "discarded", reason: "undefined-cleanup-rejection" }).then(
      () => ({ state: "resolved" as const }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    )

    expect(outcome.state).toBe("rejected")
    if (outcome.state !== "rejected") throw new Error("undefined cleanup unexpectedly resolved")
    expect(outcome.error).toBeInstanceOf(AggregateError)
    expect((outcome.error as AggregateError).errors).toHaveLength(1)
    expect(((outcome.error as AggregateError).errors[0] as Error).message).toBe("undefined")
    expect(recording.dispatches.get(ready.dispatch)?.verdict).toBe("failed")
    await expect(ready.settleDispatch({ verdict: "failed", reason: "after-undefined-cleanup" })).resolves.toBeUndefined()
  })

  test("consumed undefined quiescence failure records failed and releases the active dispatch", async () => {
    const recording = recordingPort()
    const quiesced = Promise.reject(undefined)
    void quiesced.catch(() => {})
    const lifecycle: UpstreamDispatchLifecycle = {
      cancel() {},
      async dispose() {
        return { quiesced: true, connectionReusable: false }
      },
      quiesced,
    }
    const candidate = runtime({
      env: envelope("consumed-undefined-quiescence"),
      recording: recording.port,
      open: async () => streamResponse(lifecycle, "consumed-undefined-quiescence"),
    })

    const ready = await candidate.run()
    const outcome = await ready.settleDispatch({ verdict: "committed", reason: "consumed-undefined-quiescence" }).then(
      () => ({ state: "resolved" as const }),
      (error: unknown) => ({ state: "rejected" as const, error }),
    )

    expect(outcome).toEqual({ state: "rejected", error: undefined })
    expect(recording.dispatches.get(ready.dispatch)).toMatchObject({ verdict: "failed", settlementReason: "settlement-quiesce-failed", settlementError: undefined })
    await expect(ready.settleDispatch({ verdict: "failed", reason: "after-consumed-undefined" })).resolves.toBeUndefined()
  })

  test("consumed quiescence preserves upstream diagnostics while propagating the original error", async () => {
    const recording = recordingPort()
    const upstreamError = new Error("upstream error")
    const quiesceError = new Error("consumed quiescence failed")
    const quiesced = Promise.reject(quiesceError)
    void quiesced.catch(() => {})
    const lifecycle: UpstreamDispatchLifecycle = {
      cancel() {},
      async dispose() {
        return { quiesced: true, connectionReusable: false }
      },
      quiesced,
    }
    const candidate = runtime({
      env: envelope("consumed-quiescence-diagnostics"),
      recording: recording.port,
      open: async () => streamResponse(lifecycle, "consumed-quiescence-diagnostics"),
    })

    const ready = await candidate.run()
    await expect(ready.settleDispatch({ verdict: "committed", reason: "consumed-quiescence-diagnostics", error: upstreamError })).rejects.toBe(quiesceError)
    const row = recording.dispatches.get(ready.dispatch)
    expect(row).toMatchObject({ verdict: "failed", settlementReason: "settlement-quiesce-failed" })
    expect((row?.settlementError as AggregateError).errors).toEqual([upstreamError, quiesceError])
  })

  test("consumed quiescence plus recording failure releases active ownership before retry", async () => {
    const quiesceError = new Error("consumed quiescence failed")
    const recordingError = new Error("consumed recording failed")
    const recording = recordingPort({ throwSettlementOnce: recordingError })
    const quiesced = Promise.reject(quiesceError)
    void quiesced.catch(() => {})
    const lifecycle: UpstreamDispatchLifecycle = {
      cancel() {},
      async dispose() {
        return { quiesced: true, connectionReusable: false }
      },
      quiesced,
    }
    const candidate = runtime({
      env: envelope("consumed-recording-failure"),
      recording: recording.port,
      open: async () => streamResponse(lifecycle, "consumed-recording-failure"),
    })

    const ready = await candidate.run()
    const failure = await ready.settleDispatch({ verdict: "committed", reason: "consumed-recording-failure" }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([quiesceError, recordingError])
    await expect(ready.settleDispatch({ verdict: "failed", reason: "after-consumed-recording-failure" })).resolves.toBeUndefined()
    expect(recording.dispatches.get(ready.dispatch)).toMatchObject({ verdict: "failed", settlementReason: "after-consumed-recording-failure" })
  })

  test("cleanup recording failure preserves errors and allows one terminal settlement retry", async () => {
    const cleanupError = new Error("cleanup failed")
    const recordingError = new Error("recording failed")
    const recording = recordingPort({ throwSettlementOnce: recordingError })
    const quiesced = Promise.reject(cleanupError)
    void quiesced.catch(() => {})
    const lifecycle: UpstreamDispatchLifecycle = {
      cancel() {},
      async dispose() {
        throw cleanupError
      },
      quiesced,
    }
    const candidate = runtime({
      env: envelope("recording-failure"),
      recording: recording.port,
      open: async () => streamResponse(lifecycle, "recording-failure"),
    })

    const ready = await candidate.run()
    const rejection = await candidate.disposeReadyWithSettlement({ verdict: "discarded", reason: "recording-failure" }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(rejection).toBeInstanceOf(AggregateError)
    expect((rejection as AggregateError).errors[0]).toBeInstanceOf(AggregateError)
    expect(((rejection as AggregateError).errors[0] as AggregateError).errors).toEqual([cleanupError, recordingError])
    await expect(ready.settleDispatch({ verdict: "failed", reason: "retry-after-recording-failure" })).resolves.toBeUndefined()
    expect(recording.dispatches.get(ready.dispatch)).toMatchObject({ verdict: "failed", settlementReason: "retry-after-recording-failure" })
  })

  test("429 admission replay creates a fresh dispatch in the same candidate", async () => {
    const recording = recordingPort()
    const log: Array<string> = []
    let opens = 0
    let retryDecisions = 0
    const candidate = runtime({
      env: envelope("rate-limit"),
      recording: recording.port,
      open: async () => {
        if (opens++ === 0) {
          return {
            kind: "failed-open",
            error: new HTTPError("rate limited", 429, JSON.stringify({ error: { message: "slow down" } })),
            lifecycle: settledLifecycle(log, "429"),
          }
        }
        return streamResponse(ownedLifecycle(log, "replay"), "replay-success")
      },
      decideRetry: async () => {
        retryDecisions++
        return { kind: "fail" }
      },
    })

    const ready = await candidate.run()

    expect(ready.dispatch).toBe([...recording.dispatches.keys()][1])
    expect([...recording.dispatches.values()].map((row) => [row.reason, row.verdict])).toEqual([
      ["initial", "discarded"],
      ["rate-limit-retry", undefined],
    ])
    expect(retryDecisions).toBe(0)
    await candidate.cancel("test-cleanup")
  })

  test("failed-open errors are delegated to semantic retry and re-prepare a new dispatch", async () => {
    const recording = recordingPort()
    const log: Array<string> = []
    const sentLabels: Array<string> = []
    let opens = 0
    const candidate = runtime({
      env: envelope("before-retry"),
      recording: recording.port,
      open: async (wire) => {
        sentLabels.push((wire.body as { label: string }).label)
        if (opens++ === 0) return { kind: "failed-open", error: new HTTPError("bad field", 400, "bad field"), lifecycle: settledLifecycle(log, "bad") }
        return streamResponse(ownedLifecycle(log, "semantic"), "semantic-success")
      },
      decideRetry: async ({ env }) => ({ kind: "retry", reason: "strip-bad-field", env: env.with({ body: { label: "after-retry" } }) }),
    })

    await candidate.run()

    expect(sentLabels).toEqual(["before-retry", "after-retry"])
    expect([...recording.dispatches.values()].map((row) => [row.reason, row.verdict])).toEqual([
      ["initial", "discarded"],
      ["reactive-retry", undefined],
    ])
    await candidate.cancel("test-cleanup")
  })

  test("cancel while admission is pending prevents transport open", async () => {
    const recording = recordingPort()
    let opens = 0
    let acquireStarted!: () => void
    const started = new Promise<void>((resolve) => (acquireStarted = resolve))
    const admission = {
      acquire: ({ signal }: { signal: AbortSignal }) =>
        new Promise<{ admittedAt: number; queueWaitMs: number }>((_resolve, reject) => {
          acquireStarted()
          signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true })
        }),
      observe: () => ({ kind: "complete" as const }),
      rejectAll() {},
    }
    const candidate = runtime({
      env: envelope("pending"),
      recording: recording.port,
      admission,
      open: async () => {
        opens++
        return streamResponse(ownedLifecycle([], "never"), "never")
      },
    })
    const running = candidate.run()
    await started

    await candidate.cancel("loser")

    await expect(running).rejects.toThrow(/aborted/i)
    expect(opens).toBe(0)
    expect([...recording.dispatches.values()].map((row) => row.verdict)).toEqual(["cancelled"])
    expect(recording.candidates.get(candidate.handle)?.verdict).toBe("cancelled")
  })

  test("cancel joins a lifecycle that arrives after open was already pending", async () => {
    const recording = recordingPort()
    const log: Array<string> = []
    let releaseOpen!: () => void
    const openGate = new Promise<void>((resolve) => (releaseOpen = resolve))
    let openStarted!: () => void
    const started = new Promise<void>((resolve) => (openStarted = resolve))
    const lifecycle = ownedLifecycle(log, "late-open")
    const candidate = runtime({
      env: envelope("late-open"),
      recording: recording.port,
      open: async () => {
        openStarted()
        await openGate
        return streamResponse(lifecycle, "late")
      },
    })
    const running = candidate.run()
    await started
    let cancelResolved = false
    const cancelling = candidate.cancel("late-loser").then(() => (cancelResolved = true))
    await Promise.resolve()

    expect(cancelResolved).toBe(false)
    releaseOpen()
    await cancelling

    await expect(running).rejects.toThrow("late-loser")
    expect(log).toEqual(["late-open:cancel:late-loser", "late-open:dispose:late-loser"])
    expect([...recording.dispatches.values()].map((row) => row.verdict)).toEqual(["cancelled"])
  })

  test("success returns the untouched upstream and a processor bound to its explicit dispatch", async () => {
    const recording = recordingPort()
    const log: Array<string> = []
    let pulled = 0
    const lifecycle = ownedLifecycle(log, "success")
    const upstream: UpstreamStream & { lifecycle: UpstreamDispatchLifecycle } = {
      headers: new Headers({ "x-result": "ready" }),
      lifecycle,
      frames: {
        async *[Symbol.asyncIterator]() {
          pulled++
          yield { data: "frame" }
        },
      },
    }
    const candidate = runtime({
      env: envelope("success"),
      recording: recording.port,
      open: async () => ({ kind: "stream", upstream, lifecycle }),
    })

    const ready = await candidate.run()

    expect(ready.upstream).toBe(upstream)
    expect(ready.processor.dispatch).toBe(ready.dispatch)
    expect(pulled).toBe(0)
    await candidate.cancel("loser")
    expect(log).toEqual(["success:cancel:loser", "success:dispose:loser"])
  })

  test("concurrent candidates keep preparation, admission, and settlement on their own dispatch handles", async () => {
    const recording = recordingPort()
    const log: Array<string> = []
    const a = runtime({
      env: envelope("A"),
      recording: recording.port,
      open: async (wire) => streamResponse(ownedLifecycle(log, `open-${(wire.body as { label: string }).label}`), "A"),
    })
    const b = runtime({
      env: envelope("B"),
      recording: recording.port,
      open: async (wire) => streamResponse(ownedLifecycle(log, `open-${(wire.body as { label: string }).label}`), "B"),
    })

    const [readyA, readyB] = await Promise.all([a.run(), b.run()])
    const rowA = recording.dispatches.get(readyA.dispatch)!
    const rowB = recording.dispatches.get(readyB.dispatch)!

    expect(rowA.candidate).toBe(a.handle)
    expect((rowA.wire?.body as { label: string }).label).toBe("A")
    expect(rowA.admitted).toBe(true)
    expect(rowA.openedKind).toBe("stream")
    expect(rowB.candidate).toBe(b.handle)
    expect((rowB.wire?.body as { label: string }).label).toBe("B")
    expect(rowB.admitted).toBe(true)
    expect(rowB.openedKind).toBe("stream")
    await Promise.all([a.cancel("cleanup-a"), b.cancel("cleanup-b")])
    expect(recording.dispatches.get(readyA.dispatch)?.settlementReason).toBe("cleanup-a")
    expect(recording.dispatches.get(readyB.dispatch)?.settlementReason).toBe("cleanup-b")
  })

  test("buffered recovery is described as a new child candidate, never another dispatch on the source candidate", async () => {
    const recording = recordingPort()
    const candidate = runtime({
      env: envelope("recovery"),
      recording: recording.port,
      open: async () => streamResponse(ownedLifecycle([], "source"), "source"),
    })
    await candidate.run()
    const before = recording.dispatches.size

    const recovery = candidate.recovery("truncated-before-commit")

    expect(recovery).toEqual({ role: "recovery", parentCandidate: candidate.handle, env: expect.any(Object), reason: "truncated-before-commit" })
    expect(recording.dispatches.size).toBe(before)
    await candidate.cancel("test-cleanup")
  })

  test("dispatch hard cap bounds semantic retries and settles the candidate failed", async () => {
    const recording = recordingPort()
    const candidate = runtime({
      env: envelope("budget"),
      recording: recording.port,
      maxDispatches: 2,
      open: async () => ({ kind: "failed-open", error: new HTTPError("bad", 400, "bad"), lifecycle: settledLifecycle([], "bad") }),
      decideRetry: async ({ env }) => ({ kind: "retry", reason: "again", env }),
    })

    await expect(candidate.run()).rejects.toThrow("dispatch budget exhausted (2)")

    expect(recording.dispatches.size).toBe(2)
    expect([...recording.dispatches.values()].map((row) => row.verdict)).toEqual(["discarded", "discarded"])
    expect(recording.candidates.get(candidate.handle)?.verdict).toBe("failed")
  })

  test("chained semantic retries commit only the resolution callback from the final accepted strategy", async () => {
    const recording = recordingPort()
    const resolved: Array<string> = []
    let opens = 0
    const candidate = runtime({
      env: envelope("chain-0"),
      recording: recording.port,
      open: async () => {
        if (opens++ < 2) return { kind: "failed-open", error: new HTTPError("bad", 400, "bad"), lifecycle: settledLifecycle([], `bad-${opens}`) }
        return streamResponse(ownedLifecycle([], "ok"), "ok")
      },
      decideRetry: async ({ env, dispatchNumber }) => ({
        kind: "retry",
        reason: `step-${dispatchNumber}`,
        env: env.with({ body: { label: `chain-${dispatchNumber}` } }),
        onResolved: () => {
          resolved.push(`step-${dispatchNumber}`)
        },
      }),
    })

    await candidate.run()

    expect([...recording.dispatches.values()].map((row) => row.reason)).toEqual(["initial", "reactive-retry", "reactive-retry"])
    expect(resolved).toEqual(["step-2"])
    await candidate.cancel("cleanup")
  })

  test("a throwing PhysicalTransport.open settles the dispatch and candidate failed", async () => {
    const recording = recordingPort()
    const candidate = runtime({
      env: envelope("throw"),
      recording: recording.port,
      open: async () => {
        throw new Error("contract violation")
      },
    })

    await expect(candidate.run()).rejects.toThrow("PhysicalTransport.open() threw")

    expect([...recording.dispatches.values()].map((row) => row.verdict)).toEqual(["failed"])
    expect(recording.candidates.get(candidate.handle)?.verdict).toBe("failed")
  })
})
