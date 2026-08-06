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
  closeDatabase,
  getDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { getMeta } from "~/lib/history/sqlite/meta"
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import {
  //
  clearV3Store,
  drainV3SummaryBackfill,
  ensureV3Schema,
  getV3StoreStatus,
  setV3OperationPinned,
  startV3SummaryBackfill,
} from "~/lib/history/v3/store"
import {
  //
  SUMMARY_PROJECTION_READY_KEY,
  tryMarkSummaryProjectionReady,
} from "~/lib/history/v3/summary-store"

import { commitV3HistoryEntry } from "../../helpers/history-v3-fixtures"

function entry(id: string): HistoryEntry {
  return {
    id,
    operationKind: "generation",
    sessionId: "session-summary-projection",
    startedAt: 1_000,
    endedAt: 1_250,
    durationMs: 250,
    endpoint: "anthropic-messages",
    state: "completed",
    active: false,
    pinned: false,
    clientRequest: {
      model: "gpt-5.6-sol",
      stream: true,
      messages: [{ role: "user", content: "projection needle" }],
    },
    clientResponse: {
      status: 200,
      body: { type: "message", content: [{ type: "text", text: "projection response" }] },
    },
    attempts: [],
    process: { pid: 123, bootTime: 10, version: "test" },
    model: { requested: "gpt-5.6-sol", resolved: "gpt-5.6-sol" },
  }
}

beforeEach(() => {
  closeDatabase()
  openInMemoryDatabase()
  ensureV3Schema(getDatabase())
})

afterEach(() => {
  closeDatabase()
})

describe("History V3 summary projection migration", () => {
  test("canonical insert, pin update, and parent delete maintain the projection in the same database", async () => {
    const db = getDatabase()
    await applyForwardMigrations(db)
    commitV3HistoryEntry(entry("summary-projection-op"))

    const projected = db
      .prepare(
        "SELECT operation_id,projection_status,summary_json,operation_kind,session_id,started_at,endpoint,state,pid,request_model,response_model,response_success,duration_ms,preview_text,response_preview_text,pinned FROM v3_operation_summaries WHERE operation_id=?",
      )
      .get("summary-projection-op") as Record<string, unknown> | undefined
    const canonical = db.prepare("SELECT summary_json FROM v3_operations WHERE operation_id=?").get("summary-projection-op") as
      | { summary_json: string }
      | undefined

    expect(projected).toBeDefined()
    expect(canonical).toBeDefined()
    const summary = JSON.parse(canonical!.summary_json) as Record<string, unknown>
    expect(projected).toMatchObject({
      operation_id: "summary-projection-op",
      projection_status: "ready",
      summary_json: canonical?.summary_json,
      operation_kind: summary.operationKind,
      session_id: summary.sessionId,
      started_at: summary.startedAt,
      endpoint: summary.endpoint,
      state: summary.state,
      pid: summary.pid,
      request_model: summary.requestModel,
      response_model: summary.responseModel ?? null,
      response_success: summary.responseSuccess === true ? 1 : 0,
      duration_ms: summary.durationMs,
      preview_text: summary.previewText,
      response_preview_text: summary.responsePreviewText,
      pinned: 0,
    })

    expect(setV3OperationPinned("summary-projection-op", true)).toBe(true)
    expect(db.prepare("SELECT projection_status,summary_json,pinned FROM v3_operation_summaries WHERE operation_id=?").get("summary-projection-op")).toEqual({
      projection_status: "ready",
      summary_json: canonical?.summary_json,
      pinned: 1,
    })

    clearV3Store(db)
    expect(db.prepare("SELECT COUNT(*) AS n FROM v3_operation_summaries").get()).toEqual({ n: 0 })
  })

  test("backfills historical rows and publishes readiness only after every projection is ready", async () => {
    const db = getDatabase()
    commitV3HistoryEntry(entry("historical-summary-op"))
    await applyForwardMigrations(db)

    expect(db.prepare("SELECT COUNT(*) AS n FROM v3_operation_summaries").get()).toEqual({ n: 0 })
    startV3SummaryBackfill(db, 1)
    await drainV3SummaryBackfill()

    expect(db.prepare("SELECT projection_status FROM v3_operation_summaries WHERE operation_id=?").get("historical-summary-op")).toEqual({
      projection_status: "ready",
    })
    expect(tryMarkSummaryProjectionReady(db)).toEqual({ ready: true, pending: 0, poisoned: 0 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
    expect(getV3StoreStatus()).toMatchObject({ summaryProjectionReady: true, summaryProjectionPending: 0, summaryProjectionPoisoned: 0 })

    db.prepare("UPDATE v3_operation_summaries SET endpoint='drifted' WHERE operation_id=?").run("historical-summary-op")
    expect(tryMarkSummaryProjectionReady(db)).toEqual({ ready: false, pending: 0, poisoned: 0 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()
  })

  test("a typed projection mismatch blocks readiness even when the row is marked ready", async () => {
    const db = getDatabase()
    await applyForwardMigrations(db)
    commitV3HistoryEntry(entry("typed-mismatch"))
    db.prepare("UPDATE v3_operation_summaries SET endpoint='wrong-endpoint' WHERE operation_id=?").run("typed-mismatch")

    expect(tryMarkSummaryProjectionReady(db)).toEqual({ ready: false, pending: 0, poisoned: 0 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()
  })

  test("a non-ready status blocks the marker even when all projected values are otherwise correct", async () => {
    const db = getDatabase()
    await applyForwardMigrations(db)
    commitV3HistoryEntry(entry("status-only-pending"))
    db.prepare("UPDATE v3_operation_summaries SET projection_status='pending' WHERE operation_id=?").run("status-only-pending")

    expect(tryMarkSummaryProjectionReady(db)).toEqual({ ready: false, pending: 1, poisoned: 0 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()
  })

  test("an unhydratable historical manifest becomes a visible poison and blocks readiness", async () => {
    const db = getDatabase()
    commitV3HistoryEntry(entry("poison-summary-op"))
    db.prepare("UPDATE v3_operations SET summary_json=NULL,manifest_gz=? WHERE operation_id=?").run(new Uint8Array([1, 2, 3]), "poison-summary-op")
    await applyForwardMigrations(db)

    startV3SummaryBackfill(db, 1)
    await drainV3SummaryBackfill()

    const projected = db
      .prepare("SELECT projection_status,projection_error,pinned FROM v3_operation_summaries WHERE operation_id=?")
      .get("poison-summary-op") as { projection_status: string; projection_error: string; pinned: number }
    expect(projected.projection_status).toBe("poisoned")
    expect(projected.projection_error.length).toBeGreaterThan(0)
    expect(projected.pinned).toBe(0)
    expect(tryMarkSummaryProjectionReady(db)).toEqual({ ready: false, pending: 0, poisoned: 1 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()
    expect(getV3StoreStatus()).toMatchObject({ summaryProjectionReady: false, summaryProjectionPending: 0, summaryProjectionPoisoned: 1 })
  })
})
