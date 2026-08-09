import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryPersistenceOutcome } from "~/lib/history/worker/protocol"

import { HistoryAdmissionControllerImpl } from "~/lib/history/worker/admission"
import { HistoryPersistenceRuntimeImpl } from "~/lib/history/worker/runtime"

import { ScriptedTransport } from "./fixtures/scripted-transport"
import {
  //
  buildEnvelope,
  buildStartConfig,
  buildTerminalRecord,
} from "./fixtures/semantic-envelope"

/**
 * `fatal` is the one Worker outcome that is NOT recoverable by a restart: protocol
 * incompatibility, an unowned artifact, a migration or recovery that can never succeed.
 * Everything here asserts the resulting terminal-failed transition — every un-ACKed item
 * settles exactly once, no new Worker is created, and every waiter learns about it.
 */
interface Harness {
  readonly runtime: HistoryPersistenceRuntimeImpl
  readonly transports: Array<ScriptedTransport>
  readonly restartTimers: Array<{ fn: () => void; ms: number }>
}

function harness(): Harness {
  const transports: Array<ScriptedTransport> = []
  const restartTimers: Array<{ fn: () => void; ms: number }> = []
  const runtime = new HistoryPersistenceRuntimeImpl({
    workerFactory: (generation) => {
      const transport = new ScriptedTransport(generation)
      transports.push(transport)
      return transport
    },
    // Captured, never fired unless a test says so: a scheduled restart after `fatal` is
    // exactly the defect this suite must be able to see.
    restart: {
      setTimer: (fn, ms) => {
        const entry = { fn, ms }
        restartTimers.push(entry)
        return () => {
          const index = restartTimers.indexOf(entry)
          if (index !== -1) restartTimers.splice(index, 1)
        }
      },
    },
  })
  return { runtime, transports, restartTimers }
}

async function started(): Promise<Harness> {
  const context = harness()
  const ready = context.runtime.start(buildStartConfig("/tmp/never-opened-history.db"))
  context.transports[0]?.emitReady()
  await ready
  return context
}

describe("History Worker terminal-failed state", () => {
  test("terminates every un-ACKed envelope as failed, exactly once", async () => {
    const { runtime, transports } = await started()
    const settlements: Array<Array<HistoryPersistenceOutcome>> = [[], [], []]
    for (const [index] of settlements.entries()) {
      runtime.enqueue(buildEnvelope(buildTerminalRecord(`op-fatal-${index}`)), (outcome) => settlements[index]?.push(outcome))
    }
    expect(runtime.snapshot().pendingEnvelopes).toBe(3)

    transports[0]?.emitFatal("migration recovery is unrecoverable")

    expect(settlements).toEqual([["failed"], ["failed"], ["failed"]])
    expect(runtime.snapshot().terminalFailed).toBe(true)
    expect(runtime.snapshot().ready).toBe(false)
    expect(runtime.snapshot().pendingEnvelopes).toBe(0)
    expect(runtime.snapshot().lastError).toBe("migration recovery is unrecoverable")
  })

  test("a late ACK from the dead generation cannot settle an envelope a second time", async () => {
    const { runtime, transports } = await started()
    const settlements: Array<HistoryPersistenceOutcome> = []
    const messageId = runtime.enqueue(buildEnvelope(buildTerminalRecord("op-fatal-race")), (outcome) => settlements.push(outcome))

    transports[0]?.emitFatal("owner check failed")
    expect(settlements).toEqual(["failed"])

    // The Worker's ACK was already in flight when the runtime gave up on it.
    transports[0]?.emitPersistResult(messageId, "persisted")

    expect(settlements).toEqual(["failed"])
    expect(runtime.snapshot().duplicateAcksTotal).toBe(0)
    expect(runtime.snapshot().pendingEnvelopes).toBe(0)
  })

  test("refuses to create another Worker after fatal", async () => {
    const { transports, restartTimers } = await started()

    transports[0]?.emitFatal("protocol version mismatch")

    expect(restartTimers).toHaveLength(0)
    expect(transports).toHaveLength(1)
  })

  test("a fatal during a restart window cancels the pending restart and rejects its parked requests", async () => {
    const { runtime, transports, restartTimers } = await started()
    const drain = runtime.drain()

    // Crash first: the restart timer is captured but deliberately not fired, so the runtime
    // is sitting in the restart window with the drain request parked for re-issue.
    transports[0]?.emitExit(9)
    expect(restartTimers).toHaveLength(1)
    expect(runtime.snapshot()).toMatchObject({ terminalFailed: false, restartsTotal: 1 })

    // A protocol violation observed in that window: `drain()` on a shut-down-or-broken
    // runtime is the realistic trigger, so drive it through the same public transition.
    transports[0]?.emitFatal("owner marker vanished")

    expect(restartTimers).toHaveLength(0)
    await expect(drain).rejects.toThrow(/owner marker vanished/)
    expect(transports).toHaveLength(1)
  })

  test("a drain issued during the restart window is re-issued to the replacement generation", async () => {
    const { runtime, transports, restartTimers } = await started()
    transports[0]?.emitExit(9)

    // No transport exists right now; the request must be held, not turned into a failure.
    const drain = runtime.drain()
    expect(runtime.snapshot().terminalFailed).toBe(false)

    for (const timer of restartTimers.splice(0)) timer.fn()
    expect(transports).toHaveLength(2)
    // Still not sent: the barrier may only be issued after the replay, or it would report
    // "settled" for envelopes the replacement has not received yet.
    expect(transports[1]?.sent.filter((message) => message.type === "drain")).toHaveLength(0)

    transports[1]?.emitReady()
    const reissued = transports[1]?.sent.filter((message) => message.type === "drain") ?? []
    expect(reissued).toHaveLength(1)

    transports[1]?.emit({
      type: "drained",
      protocolVersion: 1,
      workerGeneration: 2,
      requestId: reissued[0]?.requestId,
      result: { outcomes: {} },
    })
    expect(await drain).toEqual({ outcomes: {} })
  })

  test("enqueue after terminal-failed settles as failed immediately, without queuing", async () => {
    const { runtime, transports } = await started()
    transports[0]?.emitFatal("unrecoverable schema")

    const settlements: Array<HistoryPersistenceOutcome> = []
    runtime.enqueue(buildEnvelope(buildTerminalRecord("op-after-fatal")), (outcome) => settlements.push(outcome))

    expect(settlements).toEqual(["failed"])
    expect(runtime.snapshot().pendingEnvelopes).toBe(0)
    // Nothing was handed to a Worker: the terminal-failed runtime must not re-accumulate a backlog.
    expect(transports[0]?.sent.filter((message) => message.type === "persist-operation")).toHaveLength(0)
  })

  test("rejects the in-flight drain and every later drain deterministically", async () => {
    const { runtime, transports } = await started()
    const inFlight = runtime.drain()

    transports[0]?.emitFatal("journal recovery failed")

    await expect(inFlight).rejects.toThrow(/journal recovery failed/)
    await expect(runtime.drain()).rejects.toThrow(/journal recovery failed/)
    await expect(runtime.drain()).rejects.toThrow(/journal recovery failed/)
  })

  test("rejects a pending config publication waiter", async () => {
    const { runtime, transports } = await started()
    const pendingConfig = runtime.updateConfig(2, { rawConfig: { enabled: true, dbPath: "raw.db", maxObjectBytes: 2048 }, maintenanceIntervalMs: 1000 })

    transports[0]?.emitFatal("config artifact is unowned")

    await expect(pendingConfig).rejects.toThrow(/config artifact is unowned/)
    await expect(
      runtime.updateConfig(3, { rawConfig: { enabled: true, dbPath: "raw.db", maxObjectBytes: 2048 }, maintenanceIntervalMs: 1000 }),
    ).rejects.toThrow(/config artifact is unowned/)
  })

  test("re-issues a parked request only AFTER the replayed envelopes, so the drain barrier cannot lie", async () => {
    const { runtime, transports, restartTimers } = await started()
    const first = runtime.enqueue(buildEnvelope(buildTerminalRecord("op-order-a")), () => {})
    const second = runtime.enqueue(buildEnvelope(buildTerminalRecord("op-order-b")), () => {})
    expect(second).toBeGreaterThan(first)

    transports[0]?.emitExit(9)
    const drain = runtime.drain()
    for (const timer of restartTimers.splice(0)) timer.fn()
    transports[1]?.emitReady()

    const kinds = (transports[1]?.sent ?? [])
      .filter((message) => message.type === "persist-operation" || message.type === "drain")
      .map((message) => message.type)
    // The Worker serializes what it receives, so a `drain` that arrives before the replayed
    // envelopes would answer "everything received so far is settled" while those envelopes
    // were still sitting in the main thread's queue (spec §8.2).
    expect(kinds).toEqual(["persist-operation", "persist-operation", "drain"])
    const replayedIds = (transports[1]?.sent ?? []).filter((message) => message.type === "persist-operation").map((message) => message.messageId)
    expect(replayedIds).toEqual([first, second])

    const drainRequest = (transports[1]?.sent ?? []).find((message) => message.type === "drain")
    transports[1]?.emit({ type: "drained", protocolVersion: 1, workerGeneration: 2, requestId: drainRequest?.requestId, result: { outcomes: {} } })
    expect(await drain).toEqual({ outcomes: {} })
  })

  test("a restart initializes with the latest desired revision AND that revision's config", async () => {
    const { runtime, transports, restartTimers } = await started()
    const desired = { rawConfig: { enabled: true, dbPath: "raw-b.db", maxObjectBytes: 4096 }, maintenanceIntervalMs: 222 }
    void runtime.updateConfig(2, desired)

    transports[0]?.emitExit(9)
    for (const timer of restartTimers.splice(0)) timer.fn()

    const initialize = transports[1]?.sent.find((message) => message.type === "initialize")
    expect(initialize).toBeDefined()
    // Revision and config must come from ONE snapshot. Bumping only the revision would make
    // the replacement publish a descriptor labelled 2 that actually describes revision 1's
    // artifact — and §5.3 publishes that descriptor as the active raw target.
    expect(initialize?.config).toMatchObject({ configRevision: 2, rawConfig: desired.rawConfig, maintenanceIntervalMs: desired.maintenanceIntervalMs })

    // A matching ready recovers rather than going terminal: the crash was self-healing.
    transports[1]?.emitReady({ configRevision: 2, rawTarget: { configRevision: 2, requested: true, maxObjectBytes: 4096 } })
    expect(runtime.snapshot()).toMatchObject({ terminalFailed: false, ready: true, publishedRevision: 2 })
  })

  test("terminates the dead generation on fatal instead of leaving the thread alive", async () => {
    const { runtime, transports } = await started()

    transports[0]?.emitFatal("owner check failed")
    await Promise.resolve()

    // Terminal means no Worker may ever run again. A live thread nobody reads from keeps the
    // process alive and stalls the graceful shutdown §7.2 step 5 hands off to.
    expect(transports[0]?.terminated).toBe(true)
    expect(runtime.snapshot().terminalFailed).toBe(true)
  })

  test("shutdown inside the restart backoff settles un-ACKed envelopes instead of returning silently", async () => {
    const { runtime, transports, restartTimers } = await started()
    const settlements: Array<HistoryPersistenceOutcome> = []
    runtime.enqueue(buildEnvelope(buildTerminalRecord("op-backoff-1")), (outcome) => settlements.push(outcome))
    const drain = runtime.drain()

    // Crash, then shut down before the restart timer fires: no Worker exists and, once
    // stopped, none will be created — so the ACK that would settle this can never arrive.
    transports[0]?.emitExit(9)
    expect(restartTimers).toHaveLength(1)

    let drainError: unknown
    const drained = drain.then(
      () => {
        throw new Error("drain resolved even though its envelope never reached a Worker")
      },
      (error: unknown) => {
        drainError = error
      },
    )

    await runtime.shutdown()

    expect(restartTimers).toHaveLength(0)
    expect(transports).toHaveLength(1)
    // `failed` is what §8.2 step 6 escalates into a failed shutdown and exit 1 — the correct
    // report for data that never landed, and the opposite of returning a silent success.
    expect(settlements).toEqual(["failed"])
    expect(runtime.snapshot().pendingEnvelopes).toBe(0)
    await drained
    expect((drainError as Error).message).toMatch(/shut down while no Worker generation was running/)
  })

  test("gives up and goes terminal once the restart budget is spent, instead of retrying forever", async () => {
    const transports: Array<ScriptedTransport> = []
    const runtime = new HistoryPersistenceRuntimeImpl({
      workerFactory: (generation) => {
        const transport = new ScriptedTransport(generation)
        transports.push(transport)
        return transport
      },
      restart: { maxConsecutiveFailures: 3, setTimer: (fn) => (fn(), () => {}) },
    })

    const settlements: Array<HistoryPersistenceOutcome> = []
    const started = runtime.start(buildStartConfig("/tmp/never-opened-history.db"))
    transports[0]?.emitReady()
    await started
    runtime.enqueue(buildEnvelope(buildTerminalRecord("op-budget-1")), (outcome) => settlements.push(outcome))

    // Every replacement dies the moment it appears. Without a ceiling this is an infinite
    // sequence with no terminal state: `start()` would never settle, and §8.1 would never
    // let the proxy listen — a process that looks alive and serves nothing.
    for (let attempt = 0; attempt < 3; attempt++) transports.at(-1)?.emitExit(1)

    expect(runtime.snapshot().terminalFailed).toBe(true)
    expect(runtime.snapshot().lastError).toMatch(/failed to stay up after 3 consecutive attempts/)
    expect(transports).toHaveLength(3)
    // Going terminal is not a quiet abandonment: the un-ACKed envelope still settles.
    expect(settlements).toEqual(["failed"])
  })

  test("a retired generation's fatal is still believed, because it reports a permanent condition", async () => {
    const { runtime, transports, restartTimers } = await started()
    transports[0]?.emitExit(9)
    expect(restartTimers).toHaveLength(1)

    // The dead generation may not settle envelopes, but `fatal` names a condition its
    // replacement would only rediscover — dropping it would cost another doomed restart.
    transports[0]?.emitFatal("owner marker vanished")

    expect(runtime.snapshot().terminalFailed).toBe(true)
    expect(restartTimers).toHaveLength(0)
    expect(transports).toHaveLength(1)
  })

  test("a persist ACK from the generation that just crashed is NOT believed before its replacement exists", async () => {
    const { runtime, transports, restartTimers } = await started()
    let settled: HistoryPersistenceOutcome | undefined
    const messageId = runtime.enqueue(buildEnvelope(buildTerminalRecord("op-window-1")), (outcome) => {
      settled = outcome
    })

    // Crash, but do NOT fire the restart timer: `generation` still names the dead thread, so
    // without an explicit retirement flag its ACK would pass the generation guard, settle the
    // envelope, and drop it from the replay set on the word of a thread already written off.
    transports[0]?.emitExit(9)
    expect(restartTimers).toHaveLength(1)

    transports[0]?.emitPersistResult(messageId, "persisted")

    expect(settled).toBeUndefined()
    expect(runtime.snapshot().pendingEnvelopes).toBe(1)
    expect(runtime.snapshot().staleMessagesTotal).toBe(1)

    // It survives to be replayed to the replacement, which is the whole point.
    for (const timer of restartTimers.splice(0)) timer.fn()
    transports[1]?.emitReady()
    expect(transports[1]?.sent.filter((message) => message.type === "persist-operation")).toHaveLength(1)
  })

  test("refuses a second start() after terminal-failed instead of clearing the sticky flag", async () => {
    const { runtime, transports } = await started()
    transports[0]?.emitFatal("unrecoverable schema")
    await Promise.resolve()

    // `terminateTransport()` clears `this.transport`, so the "already started" guard no
    // longer catches this — and `emptyStatus()` would silently reset `terminalFailed`.
    //
    // Raced against a timer rather than asserted with `expect(...).rejects`: without the
    // guard this `start()` launches a generation that never replies, and bun's per-test
    // timeout does NOT interrupt a pending-promise assertion (measured — the file wedges and
    // the run has to be killed). Racing turns "never settled" into a normal assertion
    // failure, which is the difference between a usable red and a stalled suite.
    const settled = await Promise.race([
      runtime.start(buildStartConfig("/tmp/never-opened-history.db")).then(
        () => "resolved",
        (error: unknown) => `rejected: ${(error as Error).message}`,
      ),
      new Promise<string>((resolve) => {
        const handle = setTimeout(() => resolve("never settled"), 1000)
        handle.unref?.()
      }),
    ])

    expect(settled).toMatch(/^rejected: .*terminally failed/)
    expect(runtime.snapshot().terminalFailed).toBe(true)
    expect(transports).toHaveLength(1)
  })

  test("the outcome callback sees the POST-settlement counters, not the pre-settlement ones", async () => {
    const { runtime, transports } = await started()
    const seenDuringCallback: Array<number> = []
    const first = runtime.enqueue(buildEnvelope(buildTerminalRecord("op-counter-1")), () => {
      seenDuringCallback.push(runtime.snapshot().pendingEnvelopes)
    })
    runtime.enqueue(buildEnvelope(buildTerminalRecord("op-counter-2")), () => {})
    expect(runtime.snapshot().pendingEnvelopes).toBe(2)

    transports[0]?.emitPersistResult(first, "persisted")

    // Batch 2b's admission releases its reservation inside this callback and wakes the next
    // FIFO waiter. If the counters still described the queue as it was BEFORE this message
    // settled, that waiter would act on a depth that had already changed. Asserting after
    // the callback returns cannot see this — the value is only wrong *during* it.
    //
    // Only `pendingEnvelopes` is asserted: `pendingBytes` sums `rawCommands` byte lengths,
    // and this fixture carries none, so it is legitimately 0 either way and would not
    // discriminate.
    expect(seenDuringCallback).toEqual([1])
  })

  test("shutdown after fatal waits for the Worker to actually close", async () => {
    const transports: Array<SlowTerminateTransport> = []
    const runtime = new HistoryPersistenceRuntimeImpl({
      workerFactory: (generation) => {
        const transport = new SlowTerminateTransport(generation)
        transports.push(transport)
        return transport
      },
      restart: { setTimer: (fn) => (fn(), () => {}) },
    })
    const ready = runtime.start(buildStartConfig("/tmp/never-opened-history.db"))
    transports[0]?.emitReady()
    await ready

    transports[0]?.emitFatal("unrecoverable schema")
    expect(transports[0]?.terminateResolved).toBe(false)

    await runtime.shutdown()

    // §8.2 step 7 does not pass until the Worker is closed. `failTerminal` starts termination
    // without blocking, so shutdown is the only place left that can wait for it.
    expect(transports[0]?.terminateResolved).toBe(true)
  })

  test("each reservation is released exactly once when the runtime goes terminal-failed", async () => {
    const { runtime, transports } = await started()
    // Batch 2b installs this subscriber in production; here it stands in for that wiring so
    // the admission half of the §7.2 transition is exercised against the real controller.
    const admission = new HistoryAdmissionControllerImpl({ capacity: 2, sink: runtime })
    runtime.subscribe((status) => {
      if (status.terminalFailed) admission.close(new Error(status.lastError ?? "History Worker terminal failure"))
    })

    const outcomes: Array<Promise<HistoryPersistenceOutcome>> = []
    for (const operationId of ["op-res-1", "op-res-2"]) {
      const reservation = await admission.acquire({ signal: new AbortController().signal })
      reservation.bindOperationId(operationId)
      outcomes.push(admission.acceptTerminal(buildEnvelope(buildTerminalRecord(operationId))))
    }
    expect(admission.snapshot().reserved).toBe(2)
    expect(admission.snapshot().unacked).toBe(2)

    // Capacity is full, so this acquire is a genuine waiter at the moment fatal lands.
    // The rejection is captured with `.catch` rather than an eager `expect(...).rejects`:
    // on bun 1.3.14 an eager rejects-assertion against a not-yet-rejected promise wedges
    // the whole test file (reproduced with a two-line probe).
    let waiterError: unknown
    const waiting = admission.acquire({ signal: new AbortController().signal }).then(
      () => {
        throw new Error("waiter was admitted after the runtime went terminal-failed")
      },
      (error: unknown) => {
        waiterError = error
      },
    )
    expect(admission.snapshot().waiting).toBe(1)

    transports[0]?.emitFatal("schema is unrecoverable")

    expect(await Promise.all(outcomes)).toEqual(["failed", "failed"])
    await waiting
    expect((waiterError as Error).message).toMatch(/schema is unrecoverable/)
    expect(admission.snapshot().reserved).toBe(0)
    expect(admission.snapshot().unacked).toBe(0)
    expect(admission.snapshot().unackedMessageIds).toEqual([])
  })
})

/**
 * A transport whose `terminate()` resolves only after a macrotask.
 *
 * A promise that resolves immediately cannot tell "shutdown awaited termination" apart from
 * "shutdown happened to run after it" — the flag would already be true either way.
 */
class SlowTerminateTransport extends ScriptedTransport {
  terminateResolved = false

  override terminate(): Promise<number> {
    return new Promise<number>((resolve) => {
      setTimeout(() => {
        this.terminateResolved = true
        resolve(0)
      }, 5)
    })
  }
}
