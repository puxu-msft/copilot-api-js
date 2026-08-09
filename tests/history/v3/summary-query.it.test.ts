import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import {
  //
  clearInFlight,
  putInFlight,
} from "~/lib/history/in-flight"
import {
  //
  getHistory,
  getHistorySummaries,
  getHistorySummariesAsync,
} from "~/lib/history/queries"
import {
  //
  getSessionEntries,
  getSessionSummaries,
} from "~/lib/history/sessions"
import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import { setHistorySearchClientForTests } from "~/lib/history/state"
import { getStats } from "~/lib/history/stats"
import { ensureV3Schema } from "~/lib/history/v3/store"
import {
  //
  explainSessionEntryPagePlan,
  explainSummaryPagePlan,
  querySummaryPage,
  tryMarkSummaryProjectionReady,
} from "~/lib/history/v3/summary-store"
import {
  //
  publishModelOperationTerminal,
  resetModelOperationTerminalBusForTests,
} from "~/lib/history/v3/terminal-bus"

import { historyTerminalPublication } from "../../helpers/history-terminal-publication"
import { commitV3HistoryEntry } from "../../helpers/history-v3-fixtures"

function persist(input: {
  id: string
  startedAt: number
  operationKind?: HistoryEntry["operationKind"]
  endpoint?: HistoryEntry["endpoint"]
  state?: HistoryEntry["state"]
  requestModel?: string
  responseModel?: string
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  durationMs?: number
  sessionId?: string
  agentId?: string
  pid?: number
}): void {
  commitV3HistoryEntry({
    id: input.id,
    operationKind: input.operationKind ?? "generation",
    sessionId: input.sessionId,
    agentId: input.agentId,
    startedAt: input.startedAt,
    endedAt: input.startedAt + 10,
    endpoint: input.endpoint ?? "anthropic-messages",
    state: input.state ?? "completed",
    process: { pid: input.pid ?? 10, bootTime: 1, version: "test" },
    clientRequest: {
      model: input.requestModel ?? "request-default",
      messages: [{ role: "user", content: input.id }],
    },
    clientResponse: { status: 200 },
    attempts:
      input.responseModel ?
        [
          {
            index: 0,
            durationMs: input.durationMs ?? 0,
            upstreamResponse: { success: input.state !== "failed", model: input.responseModel, usage: input.usage },
          },
        ]
      : [],
    model: { requested: input.requestModel, resolved: input.responseModel },
  })
}

function liveEntry(id: string, startedAt: number): HistoryEntry {
  return {
    id,
    operationKind: "generation",
    startedAt,
    endpoint: "anthropic-messages",
    state: "streaming",
    active: true,
    clientRequest: { model: "live-model", messages: [{ role: "user", content: id }] },
    clientResponse: {},
    attempts: [],
    model: {},
  }
}

beforeEach(async () => {
  closeDatabase()
  openInMemoryDatabase()
  ensureV3Schema(getDatabase())
  await applyForwardMigrations(getDatabase())
})

afterEach(() => {
  setHistorySearchClientForTests(undefined)
  clearInFlight()
  // The recent-terminal bus is process-global like the in-flight map, and a record left on it is
  // an overlay row every later test in this file silently inherits.
  resetModelOperationTerminalBusForTests()
  closeDatabase()
})

describe("persisted list-search facade", () => {
  test("freezes the authoritative commit target and preserves the sidecar's ordered persisted IDs", async () => {
    persist({ id: "search-older", startedAt: 100, sessionId: "s1" })
    persist({ id: "search-newer", startedAt: 200, sessionId: "s1" })
    expect(tryMarkSummaryProjectionReady(getDatabase()).ready).toBe(true)
    const targetRow = getDatabase().prepare("SELECT MAX(committed_at) AS committed_at FROM v3_operations").get() as { committed_at: number }
    const boundaryRows = getDatabase()
      .prepare("SELECT operation_id FROM v3_operations WHERE committed_at=? ORDER BY operation_id")
      .all(targetRow.committed_at) as Array<{ operation_id: string }>
    let captured: unknown
    setHistorySearchClientForTests({
      async query() {
        return []
      },
      async getTailStatus() {
        return { lastSuccessfulTailAt: null, poisonedCount: 0, lastTailError: null }
      },
      async listSearch(request) {
        captured = request
        return {
          operationIds: ["search-newer", "search-older"],
          total: 2,
          hasOlder: false,
          hasNewer: false,
          attestation: {
            committedAt: targetRow.committed_at,
            indexedAtBoundaryMs: boundaryRows.map((row) => row.operation_id),
            poison: [],
          },
        }
      },
    })

    const result = await getHistorySummariesAsync({ search: "search", sessionId: "s1", limit: 10 })

    expect(result.entries.map((entry) => entry.id)).toEqual(["search-newer", "search-older"])
    expect(result.total).toBe(2)
    expect(captured).toMatchObject({
      query: "search",
      filters: { operationKinds: ["generation", "responses_ws"], sessionId: "s1" },
      target: {
        committedAt: targetRow.committed_at,
        operationIdsAtBoundary: boundaryRows.map((row) => row.operation_id),
      },
    })
  })

  test("short-circuits conflicting lifecycle predicates without weakening a compatible strict search", async () => {
    persist({ id: "search-failed", startedAt: 100, state: "failed" })
    expect(tryMarkSummaryProjectionReady(getDatabase()).ready).toBe(true)
    const targetRow = getDatabase().prepare("SELECT MAX(committed_at) AS committed_at FROM v3_operations").get() as { committed_at: number }
    let calls = 0
    let capturedStates: Array<string> | undefined
    setHistorySearchClientForTests({
      async query() {
        return []
      },
      async getTailStatus() {
        return { lastSuccessfulTailAt: null, poisonedCount: 0, lastTailError: null }
      },
      async listSearch(request) {
        calls++
        capturedStates = request.filters.states
        return {
          operationIds: ["search-failed"],
          total: 1,
          hasOlder: false,
          hasNewer: false,
          attestation: {
            committedAt: targetRow.committed_at,
            indexedAtBoundaryMs: ["search-failed"],
            poison: [],
          },
        }
      },
    })

    await expect(getHistorySummariesAsync({ search: "search", state: "failed", success: true })).resolves.toEqual({
      entries: [],
      total: 0,
      nextCursor: null,
      prevCursor: null,
    })
    expect(calls).toBe(0)

    const compatible = await getHistorySummariesAsync({ search: "search", state: "failed", success: false })
    expect(compatible.entries.map((entry) => entry.id)).toEqual(["search-failed"])
    expect(calls).toBe(1)
    expect(capturedStates).toEqual(["failed"])
  })

  /**
   * The overlay and the index do not agree on what "matches" means — the overlay tests a lowercase
   * substring, the index tokenizes — so a row visible to both can match on one side only. Whichever
   * way that disagreement is resolved, `total` must account for every row in `entries`; the failure
   * this guards against is a page that shows a row nothing counted.
   *
   * The resolution is that a row the index already holds belongs to the index: it is dropped from
   * the overlay rather than contributed with different semantics, so the answer stops changing as a
   * row crosses the persistence boundary.
   */
  test("does not show a persisted row the sidecar did not match, whatever the overlay's substring test says", async () => {
    persist({ id: "overlap-cartoon", startedAt: 100 })
    expect(tryMarkSummaryProjectionReady(getDatabase()).ready).toBe(true)
    const targetRow = getDatabase().prepare("SELECT MAX(committed_at) AS committed_at FROM v3_operations").get() as { committed_at: number }
    const boundaryRows = getDatabase()
      .prepare("SELECT operation_id FROM v3_operations WHERE committed_at=? ORDER BY operation_id")
      .all(targetRow.committed_at) as Array<{ operation_id: string }>

    // The SAME operation is also on the recent bus, carrying text the overlay's substring test hits.
    const recorder = createModelOperationRecorder({ identity: { operationId: "overlap-cartoon", kind: "generation", createdAt: 100 } })
    const payload = recorder.registerPayload({ messages: [{ role: "user", content: "a cartoon" }] }, { origin: { stage: "ingress", track: "client" } })
    recorder.recordIngress({ request: { payload } })
    publishModelOperationTerminal(historyTerminalPublication(recorder.commitTerminal({ outcome: "completed" })))

    // The sidecar tokenizes, so an infix like `art` does not match `cartoon`: it returns nothing.
    setHistorySearchClientForTests({
      async query() {
        return []
      },
      async getTailStatus() {
        return { lastSuccessfulTailAt: null, poisonedCount: 0, lastTailError: null }
      },
      async listSearch() {
        return {
          operationIds: [],
          total: 0,
          hasOlder: false,
          hasNewer: false,
          attestation: {
            committedAt: targetRow.committed_at,
            indexedAtBoundaryMs: boundaryRows.map((row) => row.operation_id),
            poison: [],
          },
        }
      },
    })

    const result = await getHistorySummariesAsync({ search: "art", limit: 10 })

    expect(result.total).toBeGreaterThanOrEqual(result.entries.length)
    expect(result).toMatchObject({ entries: [], total: 0 })
  })

  /**
   * The positive control for the test above, and it is not optional: after ownership moved every
   * index-visible row to the sidecar, contributing rows the index CANNOT see yet is the overlay's
   * only remaining job. Without this, replacing the overlay with an empty list passes the whole
   * file — measured, before this test existed.
   *
   * The multi-word case is here for a second reason. The overlay cannot ask the index about a row
   * the index has never seen, so it approximates the tokenizer; a plain substring test failed
   * `hello world` against `hello-world`, which hid a just-finished request from an ordinary query
   * for as long as it took the sidecar to catch up.
   */
  test("shows and counts a recent row the index cannot see yet, including for a multi-word query", async () => {
    persist({ id: "anchor-row", startedAt: 100 })
    expect(tryMarkSummaryProjectionReady(getDatabase()).ready).toBe(true)
    const targetRow = getDatabase().prepare("SELECT MAX(committed_at) AS committed_at FROM v3_operations").get() as { committed_at: number }
    const boundaryRows = getDatabase()
      .prepare("SELECT operation_id FROM v3_operations WHERE committed_at=? ORDER BY operation_id")
      .all(targetRow.committed_at) as Array<{ operation_id: string }>

    // Terminal, on the recent bus, NOT persisted — visible to nobody but the overlay.
    const recorder = createModelOperationRecorder({ identity: { operationId: "unindexed-row", kind: "generation", createdAt: 200 } })
    const payload = recorder.registerPayload(
      { messages: [{ role: "user", content: "please fix the hello-world bug" }] },
      { origin: { stage: "ingress", track: "client" } },
    )
    recorder.recordIngress({ request: { payload } })
    publishModelOperationTerminal(historyTerminalPublication(recorder.commitTerminal({ outcome: "completed" })))

    setHistorySearchClientForTests({
      async query() {
        return []
      },
      async getTailStatus() {
        return { lastSuccessfulTailAt: null, poisonedCount: 0, lastTailError: null }
      },
      async listSearch() {
        return {
          operationIds: [],
          total: 0,
          hasOlder: false,
          hasNewer: false,
          attestation: {
            committedAt: targetRow.committed_at,
            indexedAtBoundaryMs: boundaryRows.map((row) => row.operation_id),
            poison: [],
          },
        }
      },
    })

    for (const search of ["hello-world", "hello world", "fix hello"]) {
      const result = await getHistorySummariesAsync({ search, limit: 10 })
      expect(result.entries.map((entry) => entry.id)).toEqual(["unindexed-row"])
      expect(result.total).toBe(1)
    }
    // Negative control: a term that is absent must not be dragged in by the term-wise match.
    expect(await getHistorySummariesAsync({ search: "hello absent", limit: 10 })).toMatchObject({ entries: [], total: 0 })
  })

  /**
   * The overlay's tokenizer is an approximation of the index's, and the approximation was ASCII-only
   * — which produces no terms at all for a non-Latin script, silently falling through to a substring
   * test the index disagrees with. Since the overlay is the only way to see a row the index has not
   * indexed yet, that was a hole for every language that is not written in ASCII.
   *
   * The corpora here are punctuated the way the index needs to see word boundaries, and each pair is
   * one the real index matches — calibrated in `exp/history-search-list-perf/cjk-probe.ts` rather
   * than assumed, since the two tokenizers are not the same code.
   */
  test.each([
    ["你好，世界", "你好 世界"],
    ["значение по умолчанию", "значение умолчанию"],
    ["Grüße aus München", "grüße münchen"],
    ["please fix the hello-world bug", "hello world"],
  ])("matches an unindexed row for a multi-word query over %s", async (content, search) => {
    persist({ id: "anchor-row", startedAt: 100 })
    expect(tryMarkSummaryProjectionReady(getDatabase()).ready).toBe(true)
    const targetRow = getDatabase().prepare("SELECT MAX(committed_at) AS committed_at FROM v3_operations").get() as { committed_at: number }
    const boundaryRows = getDatabase()
      .prepare("SELECT operation_id FROM v3_operations WHERE committed_at=? ORDER BY operation_id")
      .all(targetRow.committed_at) as Array<{ operation_id: string }>

    const recorder = createModelOperationRecorder({ identity: { operationId: "script-row", kind: "generation", createdAt: 200 } })
    const payload = recorder.registerPayload({ messages: [{ role: "user", content }] }, { origin: { stage: "ingress", track: "client" } })
    recorder.recordIngress({ request: { payload } })
    publishModelOperationTerminal(historyTerminalPublication(recorder.commitTerminal({ outcome: "completed" })))

    // The sidecar matches nothing, so the overlay answers alone — which is exactly the window this
    // guards: a row it cannot see yet is visible only if the overlay's tokenizer agrees with it.
    setHistorySearchClientForTests({
      async query() {
        return []
      },
      async getTailStatus() {
        return { lastSuccessfulTailAt: null, poisonedCount: 0, lastTailError: null }
      },
      async listSearch() {
        return {
          operationIds: [],
          total: 0,
          hasOlder: false,
          hasNewer: false,
          attestation: {
            committedAt: targetRow.committed_at,
            indexedAtBoundaryMs: boundaryRows.map((row) => row.operation_id),
            poison: [],
          },
        }
      },
    })

    const result = await getHistorySummariesAsync({ search, limit: 10 })
    expect(result.entries.map((entry) => entry.id)).toEqual(["script-row"])
    expect(result.total).toBe(1)
  })
})

describe("persisted summary SQL query", () => {
  test("keeps the legacy read path until the projection readiness marker is published", () => {
    persist({ id: "pre-ready", startedAt: 100 })
    getDatabase().prepare("UPDATE v3_operation_summaries SET summary_json='{broken' WHERE operation_id=?").run("pre-ready")

    expect(getHistorySummaries().entries.map((row) => row.id)).toEqual(["pre-ready"])
  })

  test("default page uses the narrow ordered index without a temp sort or canonical manifest access", () => {
    const plan = explainSummaryPagePlan(getDatabase(), {}, 50)
    expect(plan.some((detail) => detail.includes("idx_v3_operation_summaries_created"))).toBe(true)
    expect(plan.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false)
    expect(plan.some((detail) => detail.includes("v3_operations"))).toBe(false)
  })

  test("applies structural filters and exact totals without hydrating manifests", () => {
    persist({ id: "main-complete", startedAt: 100, requestModel: "Client-A", responseModel: "Resolved-A", sessionId: "s1", pid: 11 })
    persist({
      id: "agent-failed",
      startedAt: 200,
      state: "failed",
      endpoint: "openai-responses",
      requestModel: "Client-B",
      sessionId: "s1",
      agentId: "a1",
      pid: 12,
    })
    persist({ id: "other-session", startedAt: 300, requestModel: "Client-C", sessionId: "s2", pid: 13 })
    persist({ id: "count-op", startedAt: 400, operationKind: "count_tokens", requestModel: "Client-A", sessionId: "s1", pid: 11 })

    expect(querySummaryPage(getDatabase(), { model: "resolved-a" }, 10).total).toBe(1)
    expect(querySummaryPage(getDatabase(), { endpoint: "openai-responses" }, 10).entries.map((row) => row.id)).toEqual(["agent-failed"])
    expect(querySummaryPage(getDatabase(), { success: false }, 10).entries.map((row) => row.id)).toEqual(["agent-failed"])
    expect(querySummaryPage(getDatabase(), { success: true, state: "failed" }, 10)).toMatchObject({ entries: [], total: 0 })
    expect(querySummaryPage(getDatabase(), { sessionId: "s1", mainAgentOnly: true, pid: 11, from: 50, to: 150 }, 10).entries.map((row) => row.id)).toEqual([
      "main-complete",
    ])
    expect(querySummaryPage(getDatabase(), { sessionId: "s1", agentId: "a1" }, 10).entries.map((row) => row.id)).toEqual(["agent-failed"])
    expect(querySummaryPage(getDatabase(), { operationKind: "all", model: "client-a" }, 10).entries.map((row) => row.id)).toEqual(["count-op", "main-complete"])
  })

  test("session aggregates stay on the narrow projection after read cutover", () => {
    persist({ id: "a-session", startedAt: 100, requestModel: "model-z", responseModel: "model-z", sessionId: "session-1", agentId: "agent-1" })
    persist({ id: "z-session", startedAt: 100, requestModel: "model-a", responseModel: "model-a", sessionId: "session-1", state: "failed" })
    persist({ id: "ws-session", startedAt: 200, operationKind: "responses_ws", requestModel: "ws-model", sessionId: "session-1" })
    expect(tryMarkSummaryProjectionReady(getDatabase()).ready).toBe(true)

    getDatabase()
      .prepare("UPDATE v3_operations SET summary_json=NULL,manifest_gz=?")
      .run(new Uint8Array([0]))

    expect(getSessionSummaries()).toEqual([
      {
        sessionId: "session-1",
        requestCount: 2,
        agentCount: 1,
        inputTokens: 0,
        outputTokens: 0,
        firstStartedAt: 100,
        lastStartedAt: 100,
        completed: 1,
        failed: 1,
        aborted: 0,
        models: ["model-z", "model-a"],
        firstPreview: "a-session",
        preview: "z-session",
      },
    ])
  })

  test("session entry pages hydrate only the IDs selected by the narrow projection", () => {
    persist({ id: "page-a", startedAt: 100, sessionId: "paged-session" })
    persist({ id: "page-b", startedAt: 200, sessionId: "paged-session" })
    persist({ id: "page-c", startedAt: 300, sessionId: "paged-session" })
    expect(tryMarkSummaryProjectionReady(getDatabase()).ready).toBe(true)
    const plan = explainSessionEntryPagePlan(getDatabase(), "paged-session", 2)
    expect(plan.some((detail) => detail.includes("idx_v3_operation_summaries_session"))).toBe(true)
    expect(plan.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false)
    expect(plan.some((detail) => detail.includes("v3_operations"))).toBe(false)
    getDatabase()
      .prepare("UPDATE v3_operations SET summary_json=NULL,manifest_gz=? WHERE operation_id='page-c'")
      .run(new Uint8Array([0]))

    expect(getSessionEntries("paged-session", { limit: 2 })).toMatchObject({
      entries: [{ id: "page-a" }, { id: "page-b" }],
      total: 3,
      nextCursor: "page-b",
      prevCursor: null,
    })
  })

  test("stats preserve the response-success fallback without an overlay exclusion", () => {
    persist({ id: "stats-fallback", startedAt: 100, requestModel: "fallback-model", responseModel: "fallback-model", sessionId: "fallback-session" })
    expect(tryMarkSummaryProjectionReady(getDatabase()).ready).toBe(true)
    getDatabase().prepare("UPDATE v3_operation_summaries SET state=NULL,response_success=1,duration_ms=10 WHERE operation_id='stats-fallback'").run()
    getDatabase()
      .prepare("UPDATE v3_operations SET summary_json=NULL,manifest_gz=?")
      .run(new Uint8Array([0]))

    expect(getStats()).toMatchObject({
      totalRequests: 1,
      successfulRequests: 1,
      failedRequests: 0,
      averageDurationMs: 10,
      modelDistribution: { "fallback-model": 1 },
      activeSessions: 1,
    })
  })

  test("stats aggregate the narrow projection and let in-flight rows replace the same persisted ID", () => {
    persist({
      id: "stats-overlay",
      startedAt: 100,
      requestModel: "persisted-model",
      responseModel: "persisted-model",
      usage: { input_tokens: 10, output_tokens: 20 },
      durationMs: 30,
      sessionId: "stats-session",
    })
    persist({
      id: "stats-failure",
      startedAt: 200,
      endpoint: "openai-responses",
      state: "failed",
      requestModel: "failed-model",
      responseModel: "failed-model",
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
      durationMs: 50,
      sessionId: "stats-session",
    })
    expect(tryMarkSummaryProjectionReady(getDatabase()).ready).toBe(true)
    getDatabase().prepare("UPDATE v3_operation_summaries SET duration_ms=50 WHERE operation_id='stats-failure'").run()
    putInFlight({ ...liveEntry("stats-overlay", 100), durationMs: 0, sessionId: "stats-session" })
    getDatabase()
      .prepare("UPDATE v3_operations SET summary_json=NULL,manifest_gz=?")
      .run(new Uint8Array([0]))

    expect(getStats()).toEqual({
      totalRequests: 2,
      successfulRequests: 0,
      failedRequests: 1,
      abortedRequests: 0,
      interruptedRequests: 0,
      totalInputTokens: 3,
      totalOutputTokens: 4,
      averageDurationMs: 25,
      modelDistribution: { "live-model": 1, "failed-model": 1 },
      endpointDistribution: { "anthropic-messages": 1, "openai-responses": 1 },
      recentActivity: [],
      activeSessions: 1,
    })
  })

  test("in-flight overlays apply state and success as intersecting predicates", () => {
    expect(tryMarkSummaryProjectionReady(getDatabase()).ready).toBe(true)
    putInFlight({ ...liveEntry("live-count", 300), operationKind: "count_tokens" })
    putInFlight({
      ...liveEntry("live-failed", 200),
      state: "failed",
      active: false,
      attempts: [{ index: 0, durationMs: 1, upstreamResponse: { success: true, model: "live-model" } }],
    })
    putInFlight({ ...liveEntry("live-aborted", 100), state: "aborted", active: false })

    expect(getHistorySummaries().entries.map((row) => row.id)).toEqual(["live-failed", "live-aborted"])
    expect(getHistory({ state: "failed", success: true })).toMatchObject({ entries: [], total: 0, totalPages: 0 })
    expect(getHistorySummaries({ state: "failed", success: true })).toEqual({ entries: [], total: 0, nextCursor: null, prevCursor: null })
    expect(getHistorySummaries({ success: false }).entries.map((row) => row.id)).toEqual(["live-failed"])
  })

  test("the facade merges in-flight rows without corrupting totals or terminal-only pages", () => {
    persist({ id: "persisted-a", startedAt: 100 })
    persist({ id: "persisted-b", startedAt: 200 })
    expect(tryMarkSummaryProjectionReady(getDatabase()).ready).toBe(true)
    putInFlight(liveEntry("live-only", 300))

    const combined = getHistorySummaries()
    expect(combined.entries.map((row) => row.id)).toEqual(["live-only", "persisted-b", "persisted-a"])
    expect(combined.total).toBe(3)

    const terminal = getHistorySummaries({ terminalOnly: true })
    expect(terminal.entries.map((row) => row.id)).toEqual(["persisted-b", "persisted-a"])
    expect(terminal.total).toBe(2)

    putInFlight(liveEntry("persisted-b", 200))
    const duplicate = getHistorySummaries()
    expect(duplicate.entries.filter((row) => row.id === "persisted-b")).toHaveLength(1)
    expect(duplicate.total).toBe(3)
  })

  test("the facade honors newer pagination after the projection cutover", () => {
    for (const [id, startedAt] of [
      ["a", 100],
      ["b", 200],
      ["c", 300],
      ["d", 400],
      ["e", 500],
    ] as const) {
      persist({ id, startedAt })
    }
    expect(tryMarkSummaryProjectionReady(getDatabase()).ready).toBe(true)

    const newer = getHistorySummaries({ cursor: "b", direction: "newer", limit: 2 })
    expect(newer.entries.map((row) => row.id)).toEqual(["d", "c"])
    expect(newer.total).toBe(5)
    expect(newer.nextCursor).toBe("c")
    expect(newer.prevCursor).toBe("d")
  })

  test("uses stable older and newer keyset pagination with equal timestamps", () => {
    for (const id of ["a", "b", "c", "d", "e"]) persist({ id, startedAt: id === "e" ? 200 : 100 })

    const first = querySummaryPage(getDatabase(), {}, 2)
    expect(first.entries.map((row) => row.id)).toEqual(["e", "d"])
    expect(first.total).toBe(5)
    expect(first.nextCursor).toBe("d")
    expect(first.prevCursor).toBeNull()

    const older = querySummaryPage(getDatabase(), { cursor: "d", direction: "older" }, 2)
    expect(older.entries.map((row) => row.id)).toEqual(["c", "b"])
    expect(older.nextCursor).toBe("b")
    expect(older.prevCursor).toBe("c")

    const newer = querySummaryPage(getDatabase(), { cursor: "b", direction: "newer" }, 2)
    expect(newer.entries.map((row) => row.id)).toEqual(["d", "c"])
    expect(newer.nextCursor).toBe("c")
    expect(newer.prevCursor).toBe("d")
  })
})
