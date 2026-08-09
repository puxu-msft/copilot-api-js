/**
 * Batch 2b: `initHistory`'s bring-up is a transaction, and lifecycle transitions do not overlap.
 *
 * The cutover replaced one idempotent `openDatabase()` with a pair of single-shot installations — `runtime.start()` rejects an already-started runtime, `installHistoryReadDatabase` refuses to shadow a live handle — with an `await` between them. That await is the whole hazard: anything that observes or mutates History's globals in the middle sees a bring-up that is neither up nor down, and the teardown paths cannot see the Worker at all because `startedDbPath` is published last.
 *
 * Two properties, each of which held only after a real defect was fixed:
 *
 * 1. A bring-up that fails AFTER `start()` succeeded still leaves the registry empty and the Worker stopped. Rolling back only `start()`'s own rejection strands a live writer that no later `shutdownHistory` can find.
 * 2. Concurrent transitions are serialized. Overlapping callers otherwise both decide a bring-up is needed, and the loser's rollback releases the winner's runtime.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type {
  //
  HistoryDrainResult,
  HistoryMessageId,
  HistoryOperationEnvelope,
  HistoryPersistenceOutcome,
  HistoryWorkerReady,
  HistoryWorkerStatus,
} from "~/lib/history/worker/protocol"
import type { HistoryPersistenceRuntime } from "~/lib/history/worker/runtime"

import { openOwnedHistoryDatabase } from "~/lib/history/sqlite/connection"
import { peekHistoryReadDatabase } from "~/lib/history/sqlite/read-connection"
import {
  //
  initHistory,
  shutdownHistory,
} from "~/lib/history/state"
import { ensureV3Schema } from "~/lib/history/v3/store"
import {
  //
  peekHistoryPersistenceRuntime,
  setHistoryPersistenceRuntimeForTests,
} from "~/lib/history/worker/registry"
import { setStateForTests } from "~/lib/state"

/** Create the semantic artifact the way the real Worker's `initialize` does, so the main thread's readonly open finds an owned database. */
function createOwnedArtifact(dbPath: string): void {
  const owned = openOwnedHistoryDatabase(dbPath)
  ensureV3Schema(owned)
  owned.close()
}

/**
 * A runtime double that mirrors the real single-use protocol: a second `start()` is rejected exactly as `HistoryPersistenceRuntimeImpl` rejects it.
 *
 * That rejection is the point. A friendlier double would let a concurrent second bring-up "succeed" and hide the very interleaving these tests exist to pin down.
 */
class LifecycleRuntime implements HistoryPersistenceRuntime {
  startCalls = 0
  shutdownCalls = 0
  started = false
  /** Resolves once a `start()` call is inside the await, so a test can interleave a second transition at exactly that point. */
  startEntered: Promise<void>
  private announceEntered!: () => void
  private gate: Promise<void> = Promise.resolve()

  private readonly options: { createArtifact: boolean; gated?: boolean }

  constructor(options: { createArtifact: boolean; gated?: boolean }) {
    this.options = options
    this.startEntered = new Promise((resolve) => (this.announceEntered = resolve))
    if (options.gated) this.gate = new Promise((resolve) => (this.releaseGate = resolve))
  }

  releaseGate: () => void = () => {}

  async start(config: { semanticDbPath: string }): Promise<HistoryWorkerReady> {
    this.startCalls++
    if (this.started) throw new Error("History Worker runtime is already started")
    // Skipping artifact creation is how this double impersonates a Worker that reported ready against a database the main thread then cannot open readonly.
    if (this.options.createArtifact) createOwnedArtifact(config.semanticDbPath)
    this.announceEntered()
    await this.gate
    this.started = true
    return {
      workerGeneration: 1,
      threadId: 1,
      selectedDriver: "bun:sqlite",
      configRevision: 1,
      rawTarget: { configRevision: 1, requested: false, maxObjectBytes: 1024 },
      recoveredJournalOperations: 0,
    } as HistoryWorkerReady
  }

  enqueue(_envelope: HistoryOperationEnvelope, _onOutcome: (outcome: HistoryPersistenceOutcome) => void): HistoryMessageId {
    return 1
  }

  updateConfig(): Promise<never> {
    throw new Error("not used by this test")
  }

  stopMaintenance(): Promise<void> {
    return Promise.resolve()
  }

  drain(): Promise<HistoryDrainResult> {
    return Promise.resolve({ outcomes: {} })
  }

  shutdown(): Promise<void> {
    this.shutdownCalls++
    this.started = false
    return Promise.resolve()
  }

  snapshot(): HistoryWorkerStatus {
    return {
      workerGeneration: 1,
      ready: this.started,
      terminalFailed: false,
      pendingEnvelopes: 0,
      pendingBytes: 0,
      latestDesiredRevision: 1,
      publishedRevision: 1,
      restartsTotal: 0,
      replaysTotal: 0,
      recoveredJournalOperations: 0,
      consecutiveFailures: 0,
      staleMessagesTotal: 0,
      duplicateAcksTotal: 0,
      outcomeCallbackErrorsTotal: 0,
      statusObserverErrorsTotal: 0,
    }
  }

  subscribe(): () => void {
    return () => {}
  }
}

const tempDirs: Array<string> = []

function freshDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-bringup-"))
  tempDirs.push(dir)
  return path.join(dir, "history.db")
}

beforeEach(async () => {
  // Take History all the way down before injecting anything. A predecessor file in this worker leaves `startedDbPath` set, and the bring-up's first act is to release "what a previous bring-up of ours left behind" — which, after the injection below, is the double itself. The registry would then be empty at `getHistoryPersistenceRuntime()`, the real in-process backend would be constructed in its place, and every assertion here would be about a runtime this test never installed. Observed as a bring-up that resolved where it was supposed to throw, but only when the file shared a worker.
  await initHistory(false)
})

afterEach(async () => {
  await shutdownHistory()
  setHistoryPersistenceRuntimeForTests(undefined)
  setStateForTests({ historyDbPath: "" })
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

describe("initHistory bring-up is a transaction", () => {
  test("a failure after start() succeeds still empties the registry and stops the Worker", async () => {
    // The Worker says ready but never created the artifact, so the readonly open — the step AFTER `start()` — is the one that throws. (Which of the two readonly-open failures fires depends on how far the artifact got: a missing file fails in SQLite, a present but unmarked one fails the owner check. Both are the same seam.)
    const runtime = new LifecycleRuntime({ createArtifact: false })
    setHistoryPersistenceRuntimeForTests(runtime)
    setStateForTests({ historyDbPath: freshDbPath() })

    await expect(initHistory(true)).rejects.toThrow(/unable to open database file|refusing to open unowned or not-yet-initialized database readonly/)

    // Started, then rolled back: leaving it installed would hand the next caller a runtime that can never start again, and no teardown path could reach it because `startedDbPath` was never published.
    expect(runtime.startCalls).toBe(1)
    expect(runtime.shutdownCalls).toBe(1)
    expect(peekHistoryPersistenceRuntime()).toBeUndefined()
    expect(peekHistoryReadDatabase()).toBeUndefined()
  })

  test("the rolled-back state lets a later bring-up succeed on its own runtime", async () => {
    const dbPath = freshDbPath()
    const failing = new LifecycleRuntime({ createArtifact: false })
    setHistoryPersistenceRuntimeForTests(failing)
    setStateForTests({ historyDbPath: dbPath })
    await expect(initHistory(true)).rejects.toThrow()

    // A stranded corpse would be found by this call and rejected as already-started/terminal.
    const healthy = new LifecycleRuntime({ createArtifact: true })
    setHistoryPersistenceRuntimeForTests(healthy)
    await initHistory(true)

    expect(healthy.startCalls).toBe(1)
    expect(peekHistoryPersistenceRuntime()).toBe(healthy)
    expect(peekHistoryReadDatabase()).toBeDefined()
  })
})

describe("History lifecycle transitions are serialized", () => {
  test("two concurrent bring-ups produce one start and a consistent end state", async () => {
    // Gated: the first call parks INSIDE `start()`, which is precisely the window in which the second call used to read a stale "nothing is installed" snapshot.
    const runtime = new LifecycleRuntime({ createArtifact: true, gated: true })
    setHistoryPersistenceRuntimeForTests(runtime)
    setStateForTests({ historyDbPath: freshDbPath() })

    const first = initHistory(true)
    await runtime.startEntered
    const second = initHistory(true)
    runtime.releaseGate()

    const settled = await Promise.allSettled([first, second])

    // Both callers asked for the same artifact, so both must get the same answer — one real bring-up plus one idempotent re-entry.
    expect(settled.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"])
    expect(runtime.startCalls).toBe(1)
    // The torn state this pins down: a released writer under a live readonly handle.
    expect(peekHistoryPersistenceRuntime()).toBe(runtime)
    expect(peekHistoryReadDatabase()).toBeDefined()
    expect(runtime.shutdownCalls).toBe(0)
  })

  test("a shutdown queued behind an in-flight bring-up still closes that Worker", async () => {
    const runtime = new LifecycleRuntime({ createArtifact: true, gated: true })
    setHistoryPersistenceRuntimeForTests(runtime)
    setStateForTests({ historyDbPath: freshDbPath() })

    const bringUp = initHistory(true)
    await runtime.startEntered
    // Overtaking the bring-up would read `startedRuntime()` as empty (the path is published last) and leave the Worker running.
    const teardown = shutdownHistory()
    runtime.releaseGate()
    await bringUp
    await teardown

    expect(runtime.shutdownCalls).toBe(1)
    expect(peekHistoryPersistenceRuntime()).toBeUndefined()
    expect(peekHistoryReadDatabase()).toBeUndefined()
  })
})
