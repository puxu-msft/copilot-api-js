import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { EntrySummary } from "~/lib/history/types"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { getHistorySummaries } from "~/lib/history/queries"
import {
  //
  initHistory,
  shutdownHistory,
} from "~/lib/history/state"
import {
  //
  drainV3Writer,
  resetV3WriterForTests,
  setV3CommitFailureInjectorForTests,
  setV3PersistRetryConfig,
} from "~/lib/history/v3/store"
import {
  //
  drainModelOperationTerminalSubscribers,
  getRecentModelOperationDurability,
  publishModelOperationTerminal,
  resetModelOperationTerminalBusForTests,
  settleRecentModelOperationDurability,
  subscribeModelOperationTerminals,
} from "~/lib/history/v3/terminal-bus"
import { getHistoryAdmissionController } from "~/lib/history/worker/registry"
import { setStateForTests } from "~/lib/state"

import { historyTerminalPublication } from "../../helpers/history-terminal-publication"
import { historyTestDbPath } from "../../helpers/test-bootstrap"

function terminalRecord(id: string) {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: Date.now() } })
  const payload = recorder.registerPayload({ model: "m", messages: [] }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ format: "anthropic-messages", request: { payload, metadata: { model: "m", messages: [] } } })
  const attempt = recorder.beginAttempt({ upstreamRequest: { payload } })
  recorder.settleAttempt(attempt, { verdict: "committed", upstreamResponse: { metadata: { model: "m" } } })
  recorder.recordEgress({ upstream: {}, client: {} })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
}

function durabilityOf(id: string): EntrySummary["durability"] {
  return getHistorySummaries().entries.find((entry) => entry.id === id)?.durability
}

beforeEach(async () => {
  resetModelOperationTerminalBusForTests()
  resetV3WriterForTests()
  setStateForTests({ historyDbPath: historyTestDbPath() })
  await initHistory(true)
  setV3PersistRetryConfig({ maxAttempts: 1, backoffMs: 0 })
})

afterEach(async () => {
  setV3CommitFailureInjectorForTests(null)
  await shutdownHistory()
  resetV3WriterForTests()
  resetModelOperationTerminalBusForTests()
  setStateForTests({ historyDbPath: "" })
  setV3PersistRetryConfig({ maxAttempts: 10, backoffMs: 10, maxBackoffMs: 5000 })
})

describe("recent terminal durability overlay", () => {
  test("publishes pending synchronously and retains failed after the writer gives up", async () => {
    setV3CommitFailureInjectorForTests(() => {
      throw new Error("forced permanent durability failure")
    })
    let observedDuringPublish: string | undefined
    const unsubscribe = subscribeModelOperationTerminals((publication) => {
      observedDuringPublish = durabilityOf(publication.record.identity.operationId)
    })

    const record = terminalRecord("durability-failed")
    const reservation = await getHistoryAdmissionController().acquire({ signal: new AbortController().signal })
    reservation.bindOperationId(record.identity.operationId)
    publishModelOperationTerminal(historyTerminalPublication(record))
    expect(observedDuringPublish).toBe("pending")
    await drainModelOperationTerminalSubscribers()
    await drainV3Writer()
    expect(durabilityOf(record.identity.operationId)).toBe("failed")
    unsubscribe()
  })

  test("an older duplicate outcome cannot overwrite the current record's durability", () => {
    resetModelOperationTerminalBusForTests()
    const older = terminalRecord("durability-generation-fence")
    const current = terminalRecord("durability-generation-fence")
    const olderPublication = historyTerminalPublication(older)
    const currentPublication = historyTerminalPublication(current)
    publishModelOperationTerminal(olderPublication)
    publishModelOperationTerminal(currentPublication)

    settleRecentModelOperationDurability(olderPublication, "failed")
    expect(getRecentModelOperationDurability(current.identity.operationId)).toBe("pending")
    settleRecentModelOperationDurability(currentPublication, "persisted")
    expect(getRecentModelOperationDurability(current.identity.operationId)).toBeUndefined()
  })

  test("clears pending after the canonical operation is persisted", async () => {
    let observedDuringPublish: string | undefined
    const unsubscribe = subscribeModelOperationTerminals((publication) => {
      observedDuringPublish = durabilityOf(publication.record.identity.operationId)
    })

    const record = terminalRecord("durability-persisted")
    const reservation = await getHistoryAdmissionController().acquire({ signal: new AbortController().signal })
    reservation.bindOperationId(record.identity.operationId)
    publishModelOperationTerminal(historyTerminalPublication(record))
    expect(observedDuringPublish).toBe("pending")
    await drainModelOperationTerminalSubscribers()
    await drainV3Writer()
    expect(durabilityOf(record.identity.operationId)).toBeUndefined()
    unsubscribe()
  })
})
