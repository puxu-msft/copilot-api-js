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
import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
import {
  //
  clearV3Store,
  ensureV3Schema,
  setV3OperationPinned,
} from "~/lib/history/v3/store"

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

beforeEach(async () => {
  closeDatabase()
  openInMemoryDatabase()
  ensureV3Schema(getDatabase())
  await applyForwardMigrations(getDatabase())
})

afterEach(() => {
  closeDatabase()
})

describe("History V3 summary projection migration", () => {
  test("canonical insert, pin update, and parent delete maintain the projection in the same database", () => {
    const db = getDatabase()
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
})
