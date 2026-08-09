/**
 * Batch 2b acceptance: the terminal-persistence contract after the semantic cutover.
 *
 * Two properties that only hold once the writer is on the other side of the Worker boundary, and that no unit test of either side can see on its own:
 *
 * 1. The terminal bus has exactly ONE production subscriber, it goes through the admission controller, and one published terminal becomes exactly one envelope handed to the runtime — no second enqueue from the request context, no leftover in-process writer path.
 * 2. Model delivery does not wait for the Worker's ACK. The reservation stays unacked while the Worker is still thinking, and is released only when the outcome arrives.
 *
 * Both drive a runtime whose ACK this test controls, because the thing under test is precisely WHEN the outcome lands relative to everything else.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ModelOperationRecord } from "~/lib/context/model-operation-record"
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

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { openOwnedHistoryDatabase } from "~/lib/history/sqlite/connection"
import {
  //
  initHistory,
  shutdownHistory,
} from "~/lib/history/state"
import { ensureV3Schema } from "~/lib/history/v3/store"
import { getRecentModelOperationDurability } from "~/lib/history/v3/terminal-bus"
import {
  //
  publishModelOperationTerminal,
  resetModelOperationTerminalBusForTests,
} from "~/lib/history/v3/terminal-bus"
import {
  //
  getHistoryAdmissionController,
  setHistoryPersistenceRuntimeForTests,
} from "~/lib/history/worker/registry"
import { setStateForTests } from "~/lib/state"

import { historyTerminalPublication } from "../../helpers/history-terminal-publication"
import { historyTestDbPath } from "../../helpers/test-bootstrap"

/**
 * A runtime whose ACK is a promise this test resolves by hand.
 *
 * Deliberately NOT the in-process backend: that one settles as fast as the event loop allows, which would make "the response did not wait for the ACK" indistinguishable from "the ACK simply arrived first". Holding the outcome open is what turns the ordering into an observation.
 */
class ManualAckRuntime implements HistoryPersistenceRuntime {
  readonly envelopes: Array<HistoryOperationEnvelope> = []
  private readonly pending = new Map<HistoryMessageId, (outcome: HistoryPersistenceOutcome) => void>()
  private nextMessageId = 1
  startCalls = 0

  enqueue(envelope: HistoryOperationEnvelope, onOutcome: (outcome: HistoryPersistenceOutcome) => void): HistoryMessageId {
    const messageId = this.nextMessageId++
    this.envelopes.push(envelope)
    this.pending.set(messageId, onOutcome)
    return messageId
  }

  /** Settle every held envelope, in arrival order. */
  ack(outcome: HistoryPersistenceOutcome = "persisted"): void {
    for (const [messageId, onOutcome] of [...this.pending]) {
      this.pending.delete(messageId)
      onOutcome(outcome)
    }
  }

  get held(): number {
    return this.pending.size
  }

  start(config: { semanticDbPath: string }): Promise<HistoryWorkerReady> {
    this.startCalls++
    // The real Worker CREATES the artifact during `initialize`; the main thread's readonly
    // handle is opened straight afterwards and would fail on a file that does not exist yet.
    // A double that skips this would make `initHistory` throw for a reason unrelated to what
    // the test is about, so it does the same minimum: own a write handle, put the schema
    // there, hand the file over.
    const owned = openOwnedHistoryDatabase(config.semanticDbPath)
    ensureV3Schema(owned)
    owned.close()
    return Promise.resolve({
      workerGeneration: 1,
      threadId: 1,
      selectedDriver: "bun:sqlite",
      configRevision: 1,
      rawTarget: { configRevision: 1, requested: false, maxObjectBytes: 1024 },
      recoveredJournalOperations: 0,
    } as HistoryWorkerReady)
  }

  updateConfig(): Promise<never> {
    throw new Error("not used by this test")
  }

  stopMaintenance(): Promise<void> {
    return Promise.resolve()
  }

  drain(): Promise<HistoryDrainResult> {
    // Mirrors the real contract: a drain settles what is outstanding rather than abandoning it.
    this.ack()
    return Promise.resolve({ outcomes: {} })
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }

  snapshot(): HistoryWorkerStatus {
    return {
      workerGeneration: 1,
      ready: true,
      terminalFailed: false,
      pendingEnvelopes: this.pending.size,
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

function terminalRecord(id: string): ModelOperationRecord {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: 1 } })
  const payload = recorder.registerPayload({ model: "m", messages: [] }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ format: "anthropic-messages", request: { payload, metadata: { model: "m", messages: [] } } })
  const attempt = recorder.beginAttempt({ upstreamRequest: { payload } })
  recorder.settleAttempt(attempt, { verdict: "committed", upstreamResponse: { metadata: { model: "m" } } })
  recorder.recordEgress({ upstream: {}, client: {} })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
}

let runtime: ManualAckRuntime

beforeEach(async () => {
  resetModelOperationTerminalBusForTests()
  runtime = new ManualAckRuntime()
  setHistoryPersistenceRuntimeForTests(runtime)
  setStateForTests({ historyDbPath: historyTestDbPath() })
  await initHistory(true)
})

afterEach(async () => {
  runtime.ack()
  await shutdownHistory()
  resetModelOperationTerminalBusForTests()
  setHistoryPersistenceRuntimeForTests(undefined)
  setStateForTests({ historyDbPath: "" })
})

describe("semantic terminal persistence after the Worker cutover", () => {
  test("one published terminal becomes exactly one envelope on the runtime", async () => {
    const record = terminalRecord("cutover-single")
    const reservation = await getHistoryAdmissionController().acquire({ signal: new AbortController().signal })
    reservation.bindOperationId(record.identity.operationId)

    publishModelOperationTerminal(historyTerminalPublication(record))
    // The subscriber is async; let it run.
    await Promise.resolve()
    await Promise.resolve()

    expect(runtime.envelopes).toHaveLength(1)
    expect(runtime.envelopes[0]?.publication.record.identity.operationId).toBe("cutover-single")
    // Exactly one enqueue means the request context did not also hand the record to a writer of its own — the old in-process path had two producers for this record.
    expect(runtime.startCalls).toBe(1)
  })

  test("the reservation stays unacked until the Worker settles, then releases", async () => {
    const record = terminalRecord("cutover-ack-gate")
    const reservation = await getHistoryAdmissionController().acquire({ signal: new AbortController().signal })
    reservation.bindOperationId(record.identity.operationId)

    publishModelOperationTerminal(historyTerminalPublication(record))
    await Promise.resolve()
    await Promise.resolve()

    // The Worker is still holding it: this is the window in which the HTTP response has already gone out.
    expect(runtime.held).toBe(1)
    expect(getHistoryAdmissionController().snapshot().unacked).toBe(1)
    expect(getRecentModelOperationDurability(record.identity.operationId)).toBe("pending")

    runtime.ack("persisted")
    await Promise.resolve()
    await Promise.resolve()

    expect(getHistoryAdmissionController().snapshot().unacked).toBe(0)
    // Settled durability is no longer "pending": the overlay stops shadowing a row the store now holds.
    expect(getRecentModelOperationDurability(record.identity.operationId)).not.toBe("pending")
  })

  test("a failed outcome releases the reservation too, and says so", async () => {
    const record = terminalRecord("cutover-failed")
    const reservation = await getHistoryAdmissionController().acquire({ signal: new AbortController().signal })
    reservation.bindOperationId(record.identity.operationId)

    publishModelOperationTerminal(historyTerminalPublication(record))
    await Promise.resolve()
    await Promise.resolve()
    runtime.ack("failed")
    await Promise.resolve()
    await Promise.resolve()

    expect(getHistoryAdmissionController().snapshot().unacked).toBe(0)
    expect(getRecentModelOperationDurability(record.identity.operationId)).toBe("failed")
  })

  test("failBeforeTerminal releases a reservation whose operation never reaches the bus", () => {
    const admission = getHistoryAdmissionController()
    return admission.acquire({ signal: new AbortController().signal }).then((reservation) => {
      reservation.bindOperationId("cutover-never-published")

      admission.failBeforeTerminal("cutover-never-published", new Error("canonical finalizer rejected"))

      expect(admission.snapshot().unacked).toBe(0)
      // Nothing was handed to the Worker: a record that never became terminal must not reach the store.
      expect(runtime.envelopes).toHaveLength(0)
    })
  })
})
