import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { createHash } from "node:crypto"

import type { HistoryEntry } from "~/lib/history/types"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
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
  commitPreparedOperation,
  drainV3SummaryBackfill,
  ensureV3Schema,
  getV3StoreStatus,
  prepareModelOperation,
  prepareModelOperationWithTransportEvidence,
  setV3OperationPinned,
  startV3SummaryBackfill,
  type TransportEvidenceInput,
  validateAndMarkSummaryProjectionReady,
} from "~/lib/history/v3/store"
import {
  //
  backfillExistingSummaryRows,
  explainSummaryBackfillPlan,
  inspectSummaryProjectionReadiness,
  SUMMARY_PROJECTION_READY_KEY,
} from "~/lib/history/v3/summary-store"

import { commitV3HistoryEntry } from "../../helpers/history-v3-fixtures"

function terminalRecord(id: string) {
  const recorder = createModelOperationRecorder({ identity: { operationId: id, kind: "generation", createdAt: 100 } })
  const request = recorder.registerPayload({ prompt: "strict readiness" }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ request: { payload: request } })
  const dispatch = recorder.beginAttempt({ effectiveRequest: { payload: request }, upstreamRequest: { payload: request } })
  recorder.settleAttempt(dispatch, { verdict: "committed" })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: dispatch })
}

function captured(bytes: Uint8Array): TransportEvidenceInput {
  const digest = createHash("sha256").update(bytes).digest("hex")
  return {
    dispatchIndex: 0,
    sequence: 1,
    capture: { availability: "captured", digest, byteLength: bytes.byteLength, encoding: "binary" },
    bytes,
  }
}

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
    expect(validateAndMarkSummaryProjectionReady(db)).toEqual({ ready: true, pending: 0, poisoned: 0 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
    expect(getV3StoreStatus()).toMatchObject({ summaryProjectionReady: true, summaryProjectionPending: 0, summaryProjectionPoisoned: 0 })

    db.prepare("UPDATE v3_operation_summaries SET endpoint='drifted' WHERE operation_id=?").run("historical-summary-op")
    expect(inspectSummaryProjectionReadiness(db)).toEqual({ ready: false, pending: 0, poisoned: 0 })
    expect(validateAndMarkSummaryProjectionReady(db)).toEqual({ ready: true, pending: 0, poisoned: 0 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
    expect(db.prepare("SELECT endpoint FROM v3_operation_summaries WHERE operation_id=?").get("historical-summary-op")).toEqual({
      endpoint: "anthropic-messages",
    })
  })

  test("checks whole-projection readiness only once after a multi-batch backfill drains", async () => {
    const db = getDatabase()
    for (const id of ["readiness-once-a", "readiness-once-b", "readiness-once-c"]) commitV3HistoryEntry(entry(id))
    await applyForwardMigrations(db)

    let checks = 0
    startV3SummaryBackfill(db, 1, (database) => {
      checks++
      return validateAndMarkSummaryProjectionReady(database)
    })
    await drainV3SummaryBackfill()

    expect(checks).toBe(1)
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
  })

  test("backfill pages advance by keyset and use the created-at index boundary", async () => {
    const db = getDatabase()
    for (const [id, startedAt] of [
      ["keyset-c", 3_000],
      ["keyset-a", 1_000],
      ["keyset-b", 2_000],
    ] as const) {
      commitV3HistoryEntry({ ...entry(id), startedAt, endedAt: startedAt + 250 })
    }
    await applyForwardMigrations(db)

    const first = backfillExistingSummaryRows(db, 1)
    const second = backfillExistingSummaryRows(db, 1, first.cursor)
    const third = backfillExistingSummaryRows(db, 1, second.cursor)
    const exhausted = backfillExistingSummaryRows(db, 1, third.cursor)

    expect(first).toEqual({ inserted: 1, cursor: { createdAt: 1_000, operationId: "keyset-a" } })
    expect(second).toEqual({ inserted: 1, cursor: { createdAt: 2_000, operationId: "keyset-b" } })
    expect(third).toEqual({ inserted: 1, cursor: { createdAt: 3_000, operationId: "keyset-c" } })
    expect(exhausted).toEqual({ inserted: 0, cursor: null })
    expect(
      explainSummaryBackfillPlan(db, first.cursor).some(
        (detail) =>
          detail.includes("SEARCH v3_operations") && detail.includes("idx_v3_operations_created") && detail.includes("(created_at,operation_id)>(?,?)"),
      ),
    ).toBe(true)
  })

  test("strict repair refuses a valid manifest whose embedded operation identity belongs to another row", async () => {
    const db = getDatabase()
    await applyForwardMigrations(db)
    const first = prepareModelOperation(terminalRecord("strict-identity-first"))
    const second = prepareModelOperation(terminalRecord("strict-identity-second"))
    commitPreparedOperation(db, first)
    commitPreparedOperation(db, second)
    expect(validateAndMarkSummaryProjectionReady(db).ready).toBe(true)
    db.prepare(
      `UPDATE v3_operations
       SET manifest_gz=(SELECT manifest_gz FROM v3_operations WHERE operation_id=?),
           digest=(SELECT digest FROM v3_operations WHERE operation_id=?)
       WHERE operation_id=?`,
    ).run(second.id, second.id, first.id)

    expect(validateAndMarkSummaryProjectionReady(db)).toEqual({ ready: false, pending: 0, poisoned: 1 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()
    expect(db.prepare("SELECT projection_status,projection_error FROM v3_operation_summaries WHERE operation_id=?").get(first.id)).toMatchObject({
      projection_status: "poisoned",
      projection_error: expect.stringContaining("manifest operation identity mismatch"),
    })
  })

  test("strict repair refuses to publish readiness when normalized evidence refs diverge from the manifest", async () => {
    const db = getDatabase()
    await applyForwardMigrations(db)
    const prepared = prepareModelOperationWithTransportEvidence(terminalRecord("strict-readiness-ref"), [
      captured(new TextEncoder().encode("strict readiness evidence")),
    ])
    commitPreparedOperation(db, prepared)
    db.prepare("UPDATE v3_operation_evidence_refs SET byte_length=byte_length+1 WHERE operation_id=?").run(prepared.id)

    expect(inspectSummaryProjectionReadiness(db)).toEqual({ ready: true, pending: 0, poisoned: 0 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()

    expect(validateAndMarkSummaryProjectionReady(db)).toEqual({ ready: false, pending: 0, poisoned: 1 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()
    expect(db.prepare("SELECT projection_status,projection_error FROM v3_operation_summaries WHERE operation_id=?").get(prepared.id)).toMatchObject({
      projection_status: "poisoned",
      projection_error: expect.stringContaining("operation evidence refs mismatch"),
    })
  })

  test("detects a typed projection mismatch before strict repair rebuilds it from canonical state", async () => {
    const db = getDatabase()
    await applyForwardMigrations(db)
    commitV3HistoryEntry(entry("typed-mismatch"))
    db.prepare("UPDATE v3_operation_summaries SET endpoint='wrong-endpoint' WHERE operation_id=?").run("typed-mismatch")

    expect(inspectSummaryProjectionReadiness(db)).toEqual({ ready: false, pending: 0, poisoned: 0 })
    expect(validateAndMarkSummaryProjectionReady(db)).toEqual({ ready: true, pending: 0, poisoned: 0 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
    expect(db.prepare("SELECT endpoint FROM v3_operation_summaries WHERE operation_id=?").get("typed-mismatch")).toEqual({ endpoint: "anthropic-messages" })
  })

  test("detects a non-ready status before strict repair republishes the canonical projection", async () => {
    const db = getDatabase()
    await applyForwardMigrations(db)
    commitV3HistoryEntry(entry("status-only-pending"))
    db.prepare("UPDATE v3_operation_summaries SET projection_status='pending' WHERE operation_id=?").run("status-only-pending")

    expect(inspectSummaryProjectionReadiness(db)).toEqual({ ready: false, pending: 1, poisoned: 0 })
    expect(validateAndMarkSummaryProjectionReady(db)).toEqual({ ready: true, pending: 0, poisoned: 0 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBe("1")
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
    expect(validateAndMarkSummaryProjectionReady(db)).toEqual({ ready: false, pending: 0, poisoned: 1 })
    expect(getMeta(db, SUMMARY_PROJECTION_READY_KEY)).toBeNull()
    expect(getV3StoreStatus()).toMatchObject({ summaryProjectionReady: false, summaryProjectionPending: 0, summaryProjectionPoisoned: 1 })
  })
})
