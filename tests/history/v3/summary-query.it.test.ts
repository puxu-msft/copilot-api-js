import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  clearInFlight,
  putInFlight,
} from "~/lib/history/in-flight"
import { getHistorySummaries } from "~/lib/history/queries"
import { getSessionSummaries } from "~/lib/history/sessions"
import {
  //
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import { ensureV3Schema } from "~/lib/history/v3/store"
import {
  //
  explainSummaryPagePlan,
  querySummaryPage,
  tryMarkSummaryProjectionReady,
} from "~/lib/history/v3/summary-store"

import { commitV3HistoryEntry } from "../../helpers/history-v3-fixtures"

function persist(input: {
  id: string
  startedAt: number
  operationKind?: HistoryEntry["operationKind"]
  endpoint?: HistoryEntry["endpoint"]
  state?: HistoryEntry["state"]
  requestModel?: string
  responseModel?: string
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
            durationMs: 0,
            upstreamResponse: { success: true, model: input.responseModel },
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
  clearInFlight()
  closeDatabase()
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
    expect(querySummaryPage(getDatabase(), { success: true, state: "failed" }, 10).entries.map((row) => row.id)).toEqual(["agent-failed"])
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
