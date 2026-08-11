/**
 * Batch 2b Step 2b.5 — the client's response does not wait for the Worker's ACK.
 *
 * The companion bus-level test (semantic-cutover.it.test.ts) proves the RESERVATION contract: a terminal stays unacked until the outcome arrives. That is a different proposition from the one that matters to a user, and the two are easy to confuse: a refactor that made the request handler await the terminal outcome before returning would leave the reservation behaving exactly as before — pending, then released — and every bus-level assertion would stay green while every request in production blocked on a disk write.
 *
 * So this one goes through the real HTTP entry point with a real mocked upstream, and the discriminator is structural rather than an assertion: the injected runtime NEVER acks. If delivery waited on the ACK, the request could not complete at all and this file would fail by timing out. Reaching the assertions is itself the proof; the assertions then confirm the envelope really was outstanding at that moment, so the ordering claim is about an actual in-flight persistence rather than about nothing having happened yet.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

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
import {
  //
  initHistory,
  shutdownHistory,
} from "~/lib/history/state"
import { ensureV3Schema } from "~/lib/history/v3/store"
import {
  //
  getHistoryAdmissionController,
  setHistoryPersistenceRuntimeForTests,
} from "~/lib/history/worker/registry"
import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import { applyFetchMock } from "../../helpers/mock-fetch"
import { createFullTestApp } from "../../helpers/test-app"
import { historyTestDbPath } from "../../helpers/test-bootstrap"

const MODEL = "claude-opus-4.8"
const app = createFullTestApp()

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL in mock: ${url}`)
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {}
  return Promise.resolve(
    new Response(
      JSON.stringify({
        id: "msg_ack_ordering",
        type: "message",
        role: "assistant",
        model: payload.model ?? MODEL,
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  )
})

/** A runtime that accepts envelopes and never settles them, unless this test says so. */
class HeldAckRuntime implements HistoryPersistenceRuntime {
  readonly envelopes: Array<HistoryOperationEnvelope> = []
  private readonly pending = new Map<HistoryMessageId, (outcome: HistoryPersistenceOutcome) => void>()
  private nextMessageId = 1

  enqueue(envelope: HistoryOperationEnvelope, onOutcome: (outcome: HistoryPersistenceOutcome) => void): HistoryMessageId {
    const messageId = this.nextMessageId++
    this.envelopes.push(envelope)
    this.pending.set(messageId, onOutcome)
    return messageId
  }

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
    // The real Worker creates the artifact during `initialize`; the main thread's readonly handle is opened straight afterwards and would fail on a file that does not exist.
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

let runtime: HeldAckRuntime

async function settleTerminalPublication(): Promise<void> {
  // The terminal subscriber runs after the response is produced; a handful of turns is enough for it to reach the sink, and none of them can advance a response that is already complete.
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

describe("model delivery does not wait for the History Worker", () => {
  useIsolatedRuntime()

  beforeEach(async () => {
    upstreamFetchMock.mockClear()
    applyFetchMock(upstreamFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
    // Down first: a predecessor may have left History up on this path, in which case the bring-up below would take the idempotent branch and adopt the double without ever starting it.
    await initHistory(false)
    runtime = new HeldAckRuntime()
    setHistoryPersistenceRuntimeForTests(runtime)
    setStateForTests({ historyDbPath: historyTestDbPath() })
    await initHistory(true)
  })

  afterEach(async () => {
    runtime.ack()
    await shutdownHistory()
    setHistoryPersistenceRuntimeForTests(undefined)
    setStateForTests({ historyDbPath: "" })
  })

  test("the client gets its full response while the Worker still holds the persistence", async () => {
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "ack-ordering" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "probe" }], max_tokens: 16 }),
    })
    // Reading the body to completion is the point: the client has everything it asked for, and the Worker has still not been told anything.
    const body = (await response.json()) as { content?: Array<{ text?: string }> }

    expect(response.status).toBe(200)
    expect(body.content?.[0]?.text).toBe("done")

    await settleTerminalPublication()

    // The envelope did reach the runtime — so the response above overtook a REAL persistence, rather than one that had not been created yet.
    expect(runtime.envelopes).toHaveLength(1)
    expect(runtime.held).toBe(1)
    expect(getHistoryAdmissionController().snapshot().unacked).toBe(1)

    // And the reservation is only released once the Worker answers.
    runtime.ack("persisted")
    await settleTerminalPublication()
    expect(getHistoryAdmissionController().snapshot().unacked).toBe(0)
  })
})
