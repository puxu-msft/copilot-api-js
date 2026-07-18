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
  getDatabase,
} from "~/lib/history/sqlite/connection"
import {
  //
  commitPreparedOperation,
  prepareModelOperation,
  resetV3WriterForTests,
} from "~/lib/history/v3/store"
import { setStateForTests } from "~/lib/state"

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
  setStateForTests({ historyDbPath: ":memory:" })
  await initHistory(true)
  resetV3WriterForTests()
  for (const item of [record("generation-1", "generation"), record("tokens-1", "count_tokens")]) {
    commitPreparedOperation(getDatabase(), prepareModelOperation(item))
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

  test("builds session summaries and chronological detail solely from V3 records", () => {
    commitPreparedOperation(
      getDatabase(),
      prepareModelOperation(record("session-first", "generation", { createdAt: 10, sessionId: "session-v3", inputTokens: 3, outputTokens: 2 })),
    )
    commitPreparedOperation(
      getDatabase(),
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

  test("persists V3 pin state and projects it into detail and summaries", () => {
    expect(setPinned("generation-1", true)).toBe(true)
    expect(getEntry("generation-1")?.pinned).toBe(true)
    expect(getHistorySummaries().entries.find((entry) => entry.id === "generation-1")?.pinned).toBe(true)

    expect(setPinned("generation-1", false)).toBe(true)
    expect(getEntry("generation-1")?.pinned).toBe(false)
  })
})
