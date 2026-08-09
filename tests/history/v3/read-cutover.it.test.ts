import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  HistoryPinUnavailableError,
  getSessionEntries,
  getSessionSummaries,
  initHistory,
  setPinned,
  shutdownHistory,
} from "~/lib/history"
import {
  //
  getEntry,
  getHistorySummaries,
} from "~/lib/history/queries"
import {
  //
  closeDatabase,
} from "~/lib/history/sqlite/connection"
import { recordToHistoryEntry } from "~/lib/history/v3/projection"
import {
  //
  commitPreparedOperation,
  getV3StoredOperation,
  prepareModelOperation,
  resetV3WriterForTests,
} from "~/lib/history/v3/store"
import { setStateForTests } from "~/lib/state"

import { clearHistoryStoreForTests, historyTestWriteDatabase } from "../../helpers/history-v3-fixtures"
import { historyTestDbPath } from "../../helpers/test-bootstrap"

function record(
  id: string,
  kind: "generation" | "count_tokens",
  options: { createdAt?: number; sessionId?: string; agentId?: string; inputTokens?: number; outputTokens?: number } = {},
) {
  const recorder = createModelOperationRecorder({
    identity: {
      operationId: id,
      kind,
      createdAt: options.createdAt ?? (kind === "generation" ? 2 : 1),
      sessionId: options.sessionId,
      agentId: options.agentId,
    },
  })
  const messages = [{ role: "user" as const, content: id }]
  const request = recorder.registerPayload({ model: "m", messages }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({
    format: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    request: { payload: request, metadata: { model: "m", messages } },
  })
  recorder.recordRouting({ requestedModel: "m", resolvedModel: "m", clientFormat: "anthropic" })
  const attempt = recorder.beginAttempt({ effectiveRequest: { payload: request }, upstreamRequest: { payload: request } })
  recorder.settleAttempt(attempt, {
    verdict: "committed",
    upstreamResponse: { payload: request, metadata: { usage: { inputTokens: options.inputTokens ?? 0, outputTokens: options.outputTokens ?? 0 } } },
  })
  recorder.recordEgress({ upstream: { payload: request }, client: { payload: request, status: 200 } })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
}

beforeEach(async () => {
  closeDatabase()
  setStateForTests({ historyDbPath: historyTestDbPath() })
  await initHistory(true)
  resetV3WriterForTests()
  // The artifact is a file now, not a fresh `:memory:` database per open, so last test's rows are still there and re-seeding the same ids would be a commit conflict.
  clearHistoryStoreForTests()
  for (const item of [record("generation-1", "generation"), record("tokens-1", "count_tokens")]) {
    commitPreparedOperation(historyTestWriteDatabase(), prepareModelOperation(item))
  }
})

afterEach(async () => {
  await shutdownHistory()
  resetV3WriterForTests()
  setStateForTests({ historyDbPath: "" })
})

describe("History V3 read cutover", () => {
  test("defaults list to generation and exposes explicit operationKind filters", () => {
    expect(getHistorySummaries().entries.map((entry) => entry.id)).toEqual(["generation-1"])
    expect(getHistorySummaries({ operationKind: "count_tokens" }).entries.map((entry) => entry.id)).toEqual(["tokens-1"])
    expect(getHistorySummaries({ operationKind: "all" }).entries.map((entry) => entry.id)).toEqual(["generation-1", "tokens-1"])
  })

  test("projects canonical detail without reading V2 rows", () => {
    expect(getEntry("generation-1")).toMatchObject({
      id: "generation-1",
      operationKind: "generation",
      state: "completed",
      clientRequest: { model: "m" },
      clientResponse: { status: 200 },
    })
  })

  test("projects canonical operation and frame timing without interpreting sequence numbers as milliseconds", () => {
    const times = [1_010, 1_020, 1_030, 1_040, 1_050, 1_060, 1_070]
    const recorder = createModelOperationRecorder({
      identity: { operationId: "timed-generation", kind: "generation", createdAt: 1_000 },
      now: () => times.shift() ?? 2_000,
    })
    const request = recorder.registerPayload({ model: "m", messages: [] }, { origin: { stage: "ingress", track: "client" } })
    const frame = recorder.registerFrame({ event: "message", data: "hello" }, { origin: { stage: "upstream", track: "upstream" } })
    recorder.recordIngress({ format: "anthropic-messages", request: { payload: request, metadata: { model: "m", messages: [] } } })
    const attempt = recorder.beginAttempt({ upstreamRequest: { payload: request } })
    recorder.settleAttempt(attempt, {
      verdict: "committed",
      upstreamResponse: { frames: [frame], frameObservations: [{ handle: frame, offsetMs: 321, type: "message", raw: "hello", observedAt: 1_341 }] },
    })
    recorder.recordEgress({
      upstream: { frames: [frame], frameObservations: [{ handle: frame, offsetMs: 321, type: "message", raw: "hello", observedAt: 1_341 }] },
      client: {
        frames: [frame],
        frameObservations: [{ handle: frame, offsetMs: 654, type: "message", raw: "hello", synthetic: "keepalive", observedAt: 1_674 }],
      },
    })
    const operation = recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
    commitPreparedOperation(historyTestWriteDatabase(), prepareModelOperation(operation))

    const stored = getV3StoredOperation("timed-generation")!
    const entry = recordToHistoryEntry(stored.record, stored)
    expect(entry).toMatchObject({
      startedAt: 1_000,
      endedAt: 1_070,
      durationMs: 70,
      lastUpdatedAt: 1_070,
      timing: { operation: { source: "canonical" } },
      clientResponse: {
        sseEvents: [{ offsetMs: 654, offsetSource: "observed", type: "message", raw: "hello", synthetic: "keepalive" }],
      },
    })
    expect(entry.attempts?.[0]).toMatchObject({ startedAt: 1_040, durationMs: 10 })
  })

  test("builds session summaries and chronological detail solely from V3 records", () => {
    commitPreparedOperation(
      historyTestWriteDatabase(),
      prepareModelOperation(record("session-first", "generation", { createdAt: 10, sessionId: "session-v3", inputTokens: 3, outputTokens: 2 })),
    )
    commitPreparedOperation(
      historyTestWriteDatabase(),
      prepareModelOperation(
        record("session-last", "generation", { createdAt: 20, sessionId: "session-v3", agentId: "agent-1", inputTokens: 5, outputTokens: 4 }),
      ),
    )

    expect(getSessionSummaries()).toContainEqual({
      sessionId: "session-v3",
      requestCount: 2,
      agentCount: 1,
      inputTokens: 8,
      outputTokens: 6,
      firstStartedAt: 10,
      lastStartedAt: 20,
      completed: 2,
      failed: 0,
      aborted: 0,
      models: ["m"],
      firstPreview: "session-first",
      preview: "session-last",
    })
    expect(getSessionEntries("session-v3", { limit: 1 })).toMatchObject({
      entries: [{ id: "session-first" }],
      total: 2,
      nextCursor: "session-first",
      prevCursor: null,
    })
    expect(getSessionEntries("session-v3", { cursor: "session-first", limit: 1 })).toMatchObject({
      entries: [{ id: "session-last" }],
      total: 2,
      nextCursor: null,
      prevCursor: "session-last",
    })
  })

  // Pinning has no writer between the Batch 2b cutover and the Batch 6 set-pinned RPC (user ruling, 2026-08-09). The V3 pin contract this used to assert — `setPinned` returns true, then detail AND the summary projection both report `pinned: true`, and setting it back to false clears both — is recorded in docs/todo/deferred-backlog.md for Batch 6 to reinstate. What remains verifiable now is that the read path still projects the column, so only the writer is missing.
  test("refuses to pin while the write connection lives in the Worker", () => {
    expect(() => setPinned("generation-1", true)).toThrow(HistoryPinUnavailableError)
    // The projection still carries the column, unpinned, rather than dropping the field.
    expect(getEntry("generation-1")?.pinned).toBeFalsy()
    expect(getHistorySummaries().entries.find((entry) => entry.id === "generation-1")?.pinned).toBeFalsy()
  })
})
