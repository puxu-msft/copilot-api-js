import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ModelOperationRecord } from "~/lib/context/model-operation-record"

import { createRequestContext } from "~/lib/context/request"
import {
  //
  configureRawCapture,
  getRawCaptureStatus,
  resetRawCaptureManagerForTests,
} from "~/lib/history/raw/manager"
import {
  //
  resetModelOperationTerminalBusForTests,
  subscribeModelOperationTerminals,
} from "~/lib/history/v3/terminal-bus"

import { historyTestReservation } from "../helpers/history-terminal-publication"

function complete(ctx: ReturnType<typeof createRequestContext>): void {
  ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: "ok" })
}

describe("generation delivery and observability terminal", () => {
  beforeEach(() => {
    resetRawCaptureManagerForTests()
    expect(configureRawCapture({ enabled: true, dbPath: ":memory:", maxObjectBytes: 1024 })).toBe(true)
  })

  afterEach(() => {
    resetRawCaptureManagerForTests()
  })

  test("delivery first waits for the later logical terminal before finalizing", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    const clientPayload = { role: "assistant", content: "ok" }

    ctx.finalizeModelOperationDelivery({ clientPayload })
    expect(ctx.modelOperationTerminalRecord).toBeNull()

    complete(ctx)
    expect(ctx.modelOperationTerminalRecord).toBeNull()
    const record = await ctx.whenModelOperationFinalized()

    expect(ctx.modelOperationTerminalRecord).toBe(record)
    expect(record.arena.payloads.find((node) => node.handle === record.egress?.client.payload)?.value).toEqual(clientPayload)
  })

  test("logical terminal first leaves client delivery complete while canonical waits for operation quiescence", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    let release!: () => void
    ctx.trackOperationBody(new Promise<void>((resolve) => (release = resolve)))

    complete(ctx)
    ctx.finalizeModelOperationDelivery({ clientPayload: { role: "assistant", content: "ok" } })

    let finalized = false
    void ctx.whenModelOperationFinalized().then(() => {
      finalized = true
    })
    await Promise.resolve()
    expect(finalized).toBe(false)
    expect(ctx.modelOperationTerminalRecord).toBeNull()
    expect(ctx.modelOperationSnapshot.egress).toBeNull()

    release()
    const record = await ctx.whenModelOperationFinalized()
    expect(record.terminal?.outcome).toBe("completed")
    expect(finalized).toBe(true)
  })

  test("publishes canonical only after quiescence and ignores every late capture after immutable seal", async () => {
    resetModelOperationTerminalBusForTests()
    const published: Array<ModelOperationRecord> = []
    const unsubscribe = subscribeModelOperationTerminals((publication) => {
      published.push(publication.record)
    })
    const ctx = createRequestContext({ endpoint: "anthropic-messages", historyReservation: historyTestReservation() })
    ctx.beginAttempt({})
    let release!: () => void
    ctx.trackOperationBody(new Promise<void>((resolve) => (release = resolve)))

    complete(ctx)
    ctx.finalizeModelOperationDelivery()
    const lateFrame = { event: "message", data: "late-before-quiesce" }
    ctx.captureForwardedGenerationFrame?.(lateFrame, { offsetMs: 1, type: "message", raw: lateFrame.data })
    expect(published).toHaveLength(0)
    expect(ctx.modelOperationTerminalRecord).toBeNull()

    release()
    const record = await ctx.whenModelOperationFinalized()
    expect(published).toEqual([record])
    expect(record.egress?.client.frames).toHaveLength(1)

    const sequence = record.lastSequence
    ctx.captureForwardedGenerationFrame?.({ event: "message", data: "forbidden-after-seal" }, { offsetMs: 2, type: "message", raw: "forbidden-after-seal" })
    expect(ctx.modelOperationSnapshot.lastSequence).toBe(sequence)
    unsubscribe()
    resetModelOperationTerminalBusForTests()
  })

  const canonicalFailureBarriers: ReadonlyArray<
    readonly [
      string,
      ((id: string, failure: { phase: "delivery" | "canonical"; error: unknown }) => boolean) | undefined,
      "failed" | "running",
      "none" | "canonical-finalization",
    ]
  > = [
    ["registered", () => true, "failed", "none"],
    ["unregistered", () => false, "running", "canonical-finalization"],
    ["missing", undefined, "running", "canonical-finalization"],
    [
      "throwing",
      () => {
        throw new Error("barrier unavailable")
      },
      "running",
      "canonical-finalization",
    ],
  ]

  test.each(canonicalFailureBarriers)(
    "keeps canonical commit failure visible when the barrier is %s",
    async (_label, onLifecycleFailure, canonical, blocker) => {
      const baselineLeases = getRawCaptureStatus().leasedOperations
      const failures: Array<{ phase: "delivery" | "canonical"; error: unknown }> = []
      const ctx = createRequestContext({
        endpoint: "anthropic-messages",
        ...(onLifecycleFailure !== undefined && {
          onLifecycleFailure: (id, failure) => {
            failures.push(failure)
            return onLifecycleFailure(id, failure)
          },
        }),
      })
      expect(getRawCaptureStatus().leasedOperations).toBe(baselineLeases + 1)
      ctx.beginGenerationCandidate({ role: "recovery" })

      complete(ctx)
      ctx.finalizeModelOperationDelivery()
      const rejection = await ctx.whenModelOperationFinalized().then(
        () => undefined,
        (error: unknown) => error,
      )

      expect(rejection).toBeInstanceOf(Error)
      expect((rejection as Error).message).toMatch(/open candidate/i)
      expect(failures).toEqual(onLifecycleFailure === undefined ? [] : [{ phase: "canonical", error: rejection }])
      expect(ctx.operationLifecycle).toMatchObject({ canonical, blocker })
      expect(ctx.modelOperationTerminalRecord).toBeNull()
      expect(getRawCaptureStatus().leasedOperations).toBe(baselineLeases)
    },
  )

  test("seals a recovery candidate as the winner instead of reopening the failed primary", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    const primary = ctx.beginGenerationCandidate({ role: "primary" })
    const primaryDispatch = ctx.beginGenerationDispatch({ candidate: primary })
    ctx.settleGenerationDispatch(primaryDispatch, { verdict: "discarded", reason: "truncated" })
    ctx.settleGenerationCandidate(primary, { verdict: "failed", reason: "truncated" })
    const recovery = ctx.beginGenerationCandidate({ role: "recovery", parentCandidate: primary })
    const recoveryDispatch = ctx.beginGenerationDispatch({ candidate: recovery })

    complete(ctx)
    ctx.finalizeModelOperationDelivery({ clientPayload: { role: "assistant", content: "recovered" } })

    const record = await ctx.whenModelOperationFinalized()
    expect(record.terminal).toMatchObject({
      outcome: "completed",
      winnerCandidate: recovery,
      committedDispatch: recoveryDispatch,
    })
    expect(record.candidates.find((candidate) => candidate.handle === primary)?.verdict).toBe("failed")
    expect(record.candidates.find((candidate) => candidate.handle === recovery)?.verdict).toBe("winner")
    const projected = (await import("~/lib/history/v3/projection")).recordToHistoryEntry(record)
    expect(projected.attempts).toMatchObject([
      { candidateId: primary, candidateRole: "primary", candidateVerdict: "failed", dispatchId: primaryDispatch, dispatchVerdict: "discarded" },
      {
        candidateId: recovery,
        candidateRole: "recovery",
        parentCandidateId: primary,
        candidateVerdict: "winner",
        dispatchId: recoveryDispatch,
        dispatchVerdict: "committed",
      },
    ])
  })
})
