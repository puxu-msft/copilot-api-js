import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  HistoryAdmissionControllerImpl,
  type HistoryTerminalSink,
} from "~/lib/history/worker/admission"
import {
  //
  HISTORY_WORKER_PROTOCOL_VERSION,
  type HistoryOperationEnvelope,
  type HistoryPersistenceOutcome,
} from "~/lib/history/worker/protocol"

function envelope(operationId: string, bytes = 3): HistoryOperationEnvelope {
  const record = createModelOperationRecorder({ identity: { operationId, kind: "generation", createdAt: 1 } }).commitTerminal({ outcome: "completed" })
  return {
    protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
    publication: {
      record,
      rawAttachment: {
        rawTarget: { configRevision: 1, requested: false, maxObjectBytes: 1024 },
        rawCommands: [{ sequence: 1, track: "upstream", kind: "sse", bytes: new Uint8Array(bytes) }],
      },
    },
  }
}

function controllableSink() {
  let nextMessageId = 1
  const outcomes = new Map<number, (outcome: HistoryPersistenceOutcome) => void>()
  const accepted: Array<{ messageId: number; operationId: string }> = []
  const sink: HistoryTerminalSink = {
    enqueue(value, onOutcome) {
      const messageId = nextMessageId++
      accepted.push({ messageId, operationId: value.publication.record.identity.operationId })
      outcomes.set(messageId, onOutcome)
      return messageId
    },
  }
  return { sink, outcomes, accepted }
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  const marker = Symbol("pending")
  expect(
    await Promise.race([
      promise.then(
        () => "settled",
        () => "settled",
      ),
      Promise.resolve(marker),
    ]),
  ).toBe(marker)
}

describe("HistoryAdmissionControllerImpl", () => {
  test("holds capacity by operation count and releases waiters in FIFO order", async () => {
    let now = 100
    const { sink } = controllableSink()
    const controller = new HistoryAdmissionControllerImpl({ capacity: 1, sink, now: () => now })

    const first = await controller.acquire({ signal: new AbortController().signal })
    const secondPromise = controller.acquire({ signal: new AbortController().signal })
    const thirdPromise = controller.acquire({ signal: new AbortController().signal })
    await expectPending(secondPromise)
    await expectPending(thirdPromise)
    expect(controller.snapshot()).toMatchObject({ capacity: 1, reserved: 1, waiting: 2, unacked: 0, overCapacity: false })

    now = 120
    first.releaseBeforeBinding("fixture complete")
    expect(() => first.releaseBeforeBinding("duplicate release")).toThrow(/already released/i)
    const second = await secondPromise
    expect(second.historyAdmissionWaitMs).toBe(20)
    await expectPending(thirdPromise)

    second.releaseBeforeBinding("fixture complete")
    const third = await thirdPromise
    expect(third.reservationId).not.toBe(second.reservationId)
    third.releaseBeforeBinding("fixture complete")
    expect(controller.snapshot()).toEqual({
      capacity: 1,
      reserved: 0,
      unacked: 0,
      waiting: 0,
      estimatedBytes: 0,
      overCapacity: false,
      preTerminalFailuresTotal: 0,
    })
  })

  test("aborts only the waiting acquire and close rejects waiters plus future acquires", async () => {
    const { sink } = controllableSink()
    const controller = new HistoryAdmissionControllerImpl({ capacity: 1, sink })
    const held = await controller.acquire({ signal: new AbortController().signal })

    const waiterAbort = new AbortController()
    const aborted = controller.acquire({ signal: waiterAbort.signal })
    waiterAbort.abort(new Error("client left"))
    await expect(aborted).rejects.toThrow("client left")
    expect(controller.snapshot().waiting).toBe(0)

    const waiting = controller.acquire({ signal: new AbortController().signal })
    controller.close(new Error("History admission closed"))
    await expect(waiting).rejects.toThrow("History admission closed")
    await expect(controller.acquire({ signal: new AbortController().signal })).rejects.toThrow("History admission closed")

    held.releaseBeforeBinding("existing reservation may finish")
    await controller.waitForQuiescence()
  })

  test("binds once, transfers to unacked once, and releases only on terminal sink outcome", async () => {
    const { sink, outcomes, accepted } = controllableSink()
    const controller = new HistoryAdmissionControllerImpl({ capacity: 1, sink })
    const reservation = await controller.acquire({ signal: new AbortController().signal })

    reservation.bindOperationId("op-1")
    expect(() => reservation.bindOperationId("op-2")).toThrow(/already bound/i)
    expect(() => reservation.releaseBeforeBinding("too late")).toThrow(/bound/i)

    const outcome = controller.acceptTerminal(envelope("op-1", 17))
    expect(accepted).toEqual([{ messageId: 1, operationId: "op-1" }])
    expect(controller.snapshot()).toMatchObject({ reserved: 1, unacked: 1, waiting: 0, estimatedBytes: 17 })
    await expectPending(outcome)
    await expect(controller.acceptTerminal(envelope("op-1"))).rejects.toThrow(/already accepted/i)

    outcomes.get(1)?.("persisted")
    await expect(outcome).resolves.toBe("persisted")
    expect(controller.snapshot()).toMatchObject({ reserved: 0, unacked: 0, estimatedBytes: 0 })
    await expect(controller.acceptTerminal(envelope("op-1"))).rejects.toThrow(/unknown operation/i)
  })

  test("failBeforeTerminal releases a bound reservation exactly once", async () => {
    const { sink } = controllableSink()
    const controller = new HistoryAdmissionControllerImpl({ capacity: 1, sink })
    const reservation = await controller.acquire({ signal: new AbortController().signal })
    reservation.bindOperationId("op-failed")

    controller.failBeforeTerminal("op-failed", new Error("context construction failed"))
    expect(controller.snapshot()).toMatchObject({
      reserved: 0,
      preTerminalFailuresTotal: 1,
      lastPreTerminalError: "context construction failed",
    })
    expect(() => controller.failBeforeTerminal("op-failed", new Error("duplicate"))).toThrow(/unknown operation/i)
  })

  test("hot resize preserves reservations and does not release a waiter until reserved is below capacity", async () => {
    const { sink } = controllableSink()
    const controller = new HistoryAdmissionControllerImpl({ capacity: 3, sink })
    const first = await controller.acquire({ signal: new AbortController().signal })
    const second = await controller.acquire({ signal: new AbortController().signal })
    const third = await controller.acquire({ signal: new AbortController().signal })
    const fourthPromise = controller.acquire({ signal: new AbortController().signal })
    const fifthPromise = controller.acquire({ signal: new AbortController().signal })

    controller.updateCapacity(1)
    expect(controller.snapshot()).toMatchObject({ capacity: 1, reserved: 3, waiting: 2, overCapacity: true })
    first.releaseBeforeBinding("done")
    second.releaseBeforeBinding("done")
    await expectPending(fourthPromise)
    third.releaseBeforeBinding("done")

    const fourth = await fourthPromise
    await expectPending(fifthPromise)
    expect(controller.snapshot()).toMatchObject({ capacity: 1, reserved: 1, waiting: 1, overCapacity: false })

    controller.updateCapacity(2)
    const fifth = await fifthPromise
    expect(controller.snapshot()).toMatchObject({ capacity: 2, reserved: 2, waiting: 0, overCapacity: false })
    fourth.releaseBeforeBinding("done")
    fifth.releaseBeforeBinding("done")
  })

  test("observes queued bytes without using them for admission", async () => {
    const { sink, outcomes } = controllableSink()
    const controller = new HistoryAdmissionControllerImpl({ capacity: 2, sink })
    const first = await controller.acquire({ signal: new AbortController().signal })
    const second = await controller.acquire({ signal: new AbortController().signal })
    first.bindOperationId("large")
    second.bindOperationId("small")

    const large = controller.acceptTerminal(envelope("large", 1_000_000))
    const small = controller.acceptTerminal(envelope("small", 1))
    expect(controller.snapshot()).toMatchObject({ capacity: 2, reserved: 2, unacked: 2, estimatedBytes: 1_000_001 })

    outcomes.get(1)?.("persisted")
    outcomes.get(2)?.("conflict")
    await expect(large).resolves.toBe("persisted")
    await expect(small).resolves.toBe("conflict")
  })

  test("pause drains pre-pause waiters but holds later acquires until resume", async () => {
    const { sink } = controllableSink()
    const controller = new HistoryAdmissionControllerImpl({ capacity: 1, sink })
    const first = await controller.acquire({ signal: new AbortController().signal })
    const beforePause = controller.acquire({ signal: new AbortController().signal })
    const paused = controller.pause("raw-authority-handoff")
    const afterPause = controller.acquire({ signal: new AbortController().signal })
    await expectPending(paused)

    first.releaseBeforeBinding("done")
    const admittedBeforePause = await beforePause
    await expect(paused).resolves.toBeUndefined()
    await expectPending(afterPause)

    admittedBeforePause.releaseBeforeBinding("done")
    await expectPending(afterPause)
    controller.resume()
    const admittedAfterPause = await afterPause
    admittedAfterPause.releaseBeforeBinding("done")
  })

  test("waitForQuiescence resolves only after all reservations settle", async () => {
    const { sink, outcomes } = controllableSink()
    const controller = new HistoryAdmissionControllerImpl({ capacity: 1, sink })
    const reservation = await controller.acquire({ signal: new AbortController().signal })
    reservation.bindOperationId("op-quiet")
    const outcome = controller.acceptTerminal(envelope("op-quiet"))
    const quiet = controller.waitForQuiescence()
    await expectPending(quiet)

    outcomes.get(1)?.("failed")
    await expect(outcome).resolves.toBe("failed")
    await expect(quiet).resolves.toBeUndefined()
  })
})
