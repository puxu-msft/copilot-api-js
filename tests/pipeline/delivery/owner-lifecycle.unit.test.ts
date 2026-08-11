/**
 * Commit 2's lifecycle half: first terminal wins, `finalize` seals once and cannot emit, and the
 * heartbeat is bracketed by the batch rather than handed to callers.
 *
 * The heartbeat tests use an injected timer seam, not wall-clock waits. The activity control comes
 * first on purpose: "no keepalive appeared while suspended" is worthless until you have shown the
 * timer fires at all, since a timer that never fires satisfies it too.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { HeartbeatTimerSeam } from "~/lib/pipeline/delivery/heartbeat-controller"

import { createHeartbeatController } from "~/lib/pipeline/delivery/heartbeat-controller"
import {
  //
  createTerminalStateMachine,
  dispositionForFailedTerminate,
  ForeignTerminalResultError,
  TerminalAlreadyRunError,
  terminalDispositionForSuppression,
} from "~/lib/pipeline/delivery/owner-lifecycle"

/** A timer the test drives by hand: `fire()` runs whatever is currently scheduled. */
function manualTimer(): HeartbeatTimerSeam & { fire(): void; readonly scheduled: boolean } {
  let pending: (() => void) | undefined
  return {
    set(callback) {
      pending = callback
      return { id: 1 }
    },
    clear() {
      pending = undefined
    },
    get scheduled() {
      return pending !== undefined
    },
    fire() {
      const callback = pending
      pending = undefined
      callback?.()
    },
  }
}

function resultInput() {
  return {
    terminalFrameDisposition: "emitted" as const,
    attemptedSegments: [],
    succeededSegments: [],
    forwardedSnapshot: [],
    socketCloseIntent: "none" as const,
  }
}

describe("terminal state machine", () => {
  test("first terminal command wins; the loser is told, not silently ignored", () => {
    const machine = createTerminalStateMachine()
    machine.claimTerminal("complete")

    expect(machine.terminated).toBe(true)
    expect(() => {
      machine.claimTerminal("request-cancelled")
    }).toThrow(TerminalAlreadyRunError)
  })

  test("finalize seals exactly once and reports which call did it", () => {
    const machine = createTerminalStateMachine()
    machine.claimTerminal("complete")
    const result = machine.issueResult(resultInput())

    expect(machine.finalize(result)).toBe(true)
    expect(machine.finalize(result)).toBe(false)
    expect(machine.finalized).toBe(true)
  })

  test("finalize refuses a result this owner did not issue", () => {
    const mine = createTerminalStateMachine()
    const theirs = createTerminalStateMachine()
    const foreign = theirs.issueResult(resultInput())

    // This is what keeps `finalize` from being a second emission entry point: it can only seal an
    // operation this owner already terminated.
    expect(() => mine.finalize(foreign)).toThrow(ForeignTerminalResultError)
  })

  test("the no-result branch still seals once", () => {
    const machine = createTerminalStateMachine()
    expect(machine.finalizeWithoutResult("client-aborted")).toBe(true)
    expect(machine.finalizeWithoutResult("client-aborted")).toBe(false)
  })
})

describe("the one cell where the two axes meet", () => {
  test("a failed terminate maps to a caller disposition, by name rather than by improvisation", () => {
    expect(dispositionForFailedTerminate("client-gone", true, false)).toEqual({ kind: "client-aborted", reason: "client-gone", partialDelivery: true })
    expect(dispositionForFailedTerminate("session-terminating", false, true)).toEqual({ kind: "delivery-finished", reason: "session-terminating" })

    const unsettled = dispositionForFailedTerminate("session-terminating", false, false)
    expect(unsettled.kind).toBe("fail-loud")
    const torn = dispositionForFailedTerminate("wire-torn", false, true)
    expect(torn.kind).toBe("fail-loud")
    expect(torn.reason).toBe("wire-torn")
  })

  test("a suppressed terminal frame names which lifecycle reason suppressed it", () => {
    expect(terminalDispositionForSuppression("client-gone")).toBe("suppressed_client_gone")
    expect(terminalDispositionForSuppression("session-terminating")).toBe("suppressed_session_terminating")
  })
})

describe("heartbeat controller", () => {
  test("liveness control: an armed heartbeat ticks once per interval", () => {
    const timer = manualTimer()
    let ticks = 0
    const heartbeat = createHeartbeatController({ intervalMs: 10, tick: () => ticks++, timer })

    heartbeat.arm()
    timer.fire()
    timer.fire()
    timer.fire()

    // Without this, every "no keepalive while suspended" assertion below would also pass on a
    // controller whose timer never fires at all.
    expect(ticks).toBe(3)
  })

  test("a batch suspends the heartbeat and re-arms a fresh interval afterwards", async () => {
    const timer = manualTimer()
    let ticks = 0
    const heartbeat = createHeartbeatController({ intervalMs: 10, tick: () => ticks++, timer })
    heartbeat.arm()

    await heartbeat.runBatch(
      async () => {
        expect(timer.scheduled).toBe(false)
        return "batch"
      },
      () => false,
    )

    expect(ticks).toBe(0)
    expect(timer.scheduled).toBe(true)
    timer.fire()
    expect(ticks).toBe(1)
  })

  test("a batch that terminated does not re-arm — nothing is left to keep alive", async () => {
    const timer = manualTimer()
    let ticks = 0
    const heartbeat = createHeartbeatController({ intervalMs: 10, tick: () => ticks++, timer })
    heartbeat.arm()

    await heartbeat.runBatch(
      async () => "terminated",
      (result) => result === "terminated",
    )

    expect(timer.scheduled).toBe(false)
    expect(heartbeat.stopped).toBe(true)
  })

  test("a batch that threw still re-arms — a failed batch is not a reason to stop the stream", async () => {
    const timer = manualTimer()
    const heartbeat = createHeartbeatController({ intervalMs: 10, tick: () => undefined, timer })
    heartbeat.arm()

    await expect(
      heartbeat.runBatch(
        async () => {
          throw new Error("batch failed")
        },
        () => false,
      ),
    ).rejects.toThrow("batch failed")

    expect(timer.scheduled).toBe(true)
  })

  test("stopPermanently is final; arming afterwards is a no-op", () => {
    const timer = manualTimer()
    let ticks = 0
    const heartbeat = createHeartbeatController({ intervalMs: 10, tick: () => ticks++, timer })
    heartbeat.arm()
    heartbeat.stopPermanently()

    expect(timer.scheduled).toBe(false)
    heartbeat.arm()
    expect(timer.scheduled).toBe(false)
    expect(ticks).toBe(0)
  })
})
