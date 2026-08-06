import type { Database } from "~/lib/history/sqlite/connection"
import type {
  //
  EntrySummary,
  QueryOptions,
  SummaryResult,
} from "~/lib/history/types"

import {
  //
  deleteMeta,
  getMeta,
  setMeta,
} from "~/lib/history/sqlite/meta"

export const SUMMARY_PROJECTION_READY_KEY = "summary_projection_ready"

export interface SummaryProjectionField {
  column: string
  sqlType: string
  source: (row: string) => string
}

const json =
  (path: string) =>
  (row: string): string =>
    `json_extract(${row}.summary_json, '${path}')`
const column =
  (name: string) =>
  (row: string): string =>
    `${row}.${name}`

/**
 * Single field map for the compatibility triggers, historical backfill, and the
 * post-convergence direct writer. Keep the SQL projection in one place so those
 * three write paths cannot silently drift.
 */
export const SUMMARY_PROJECTION_FIELDS = [
  { column: "operation_id", sqlType: "TEXT PRIMARY KEY REFERENCES v3_operations(operation_id) ON DELETE CASCADE", source: column("operation_id") },
  { column: "summary_json", sqlType: "TEXT", source: column("summary_json") },
  {
    column: "projection_status",
    sqlType: "TEXT NOT NULL CHECK(projection_status IN ('pending','ready','poisoned'))",
    source: (row: string) => `CASE WHEN ${row}.summary_json IS NULL THEN 'pending' ELSE 'ready' END`,
  },
  { column: "projection_error", sqlType: "TEXT", source: () => "NULL" },
  { column: "operation_kind", sqlType: "TEXT NOT NULL", source: column("kind") },
  { column: "session_id", sqlType: "TEXT", source: json("$.sessionId") },
  { column: "agent_id", sqlType: "TEXT", source: json("$.agentId") },
  { column: "started_at", sqlType: "INTEGER NOT NULL", source: column("created_at") },
  { column: "ended_at", sqlType: "INTEGER", source: column("ended_at") },
  { column: "endpoint", sqlType: "TEXT", source: json("$.endpoint") },
  { column: "state", sqlType: "TEXT", source: json("$.state") },
  { column: "pid", sqlType: "INTEGER", source: json("$.pid") },
  { column: "request_model", sqlType: "TEXT", source: json("$.requestModel") },
  { column: "response_model", sqlType: "TEXT", source: json("$.responseModel") },
  { column: "response_success", sqlType: "INTEGER", source: json("$.responseSuccess") },
  { column: "duration_ms", sqlType: "INTEGER", source: json("$.durationMs") },
  { column: "input_tokens", sqlType: "INTEGER", source: json("$.usage.input_tokens") },
  { column: "output_tokens", sqlType: "INTEGER", source: json("$.usage.output_tokens") },
  { column: "cache_read_input_tokens", sqlType: "INTEGER", source: json("$.usage.cache_read_input_tokens") },
  { column: "cache_creation_input_tokens", sqlType: "INTEGER", source: json("$.usage.cache_creation_input_tokens") },
  { column: "preview_text", sqlType: "TEXT", source: json("$.previewText") },
  { column: "response_preview_text", sqlType: "TEXT", source: json("$.responsePreviewText") },
  { column: "pinned", sqlType: "INTEGER NOT NULL", source: column("pinned") },
] as const satisfies ReadonlyArray<SummaryProjectionField>

const projectionColumns = SUMMARY_PROJECTION_FIELDS.map((field) => field.column).join(",")
const newProjectionValues = SUMMARY_PROJECTION_FIELDS.map((field) => field.source("NEW")).join(",")
const readyAssignments = SUMMARY_PROJECTION_FIELDS.filter(
  (field) => !["operation_id", "pinned", "projection_error", "projection_status"].includes(field.column),
)
  .map((field) => `${field.column}=${field.source("NEW")}`)
  .join(",")

const historicalProjectionValues = SUMMARY_PROJECTION_FIELDS.map((field) => field.source("v3_operations")).join(",")
const projectionEquality = SUMMARY_PROJECTION_FIELDS.filter((field) => !["operation_id", "projection_error", "projection_status"].includes(field.column))
  .map((field) => `s.${field.column} IS (${field.source("o")})`)
  .join(" AND ")

export const SUMMARY_PROJECTION_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS v3_operation_summaries (
  ${SUMMARY_PROJECTION_FIELDS.map((field) => `${field.column} ${field.sqlType}`).join(",\n  ")}
);
CREATE INDEX IF NOT EXISTS idx_v3_operation_summaries_kind_created
  ON v3_operation_summaries(operation_kind, started_at DESC, operation_id DESC);
CREATE INDEX IF NOT EXISTS idx_v3_operation_summaries_created
  ON v3_operation_summaries(started_at DESC, operation_id DESC);
CREATE INDEX IF NOT EXISTS idx_v3_operation_summaries_session
  ON v3_operation_summaries(session_id, started_at DESC, operation_id DESC);

CREATE TRIGGER IF NOT EXISTS v3_operation_summaries_after_insert
AFTER INSERT ON v3_operations
BEGIN
  INSERT INTO v3_operation_summaries(${projectionColumns}) VALUES(${newProjectionValues});
END;

CREATE TRIGGER IF NOT EXISTS v3_operation_summaries_after_summary_update
AFTER UPDATE OF summary_json ON v3_operations
WHEN NEW.summary_json IS NOT NULL
BEGIN
  UPDATE v3_operation_summaries SET
    ${readyAssignments},
    projection_status='ready',
    projection_error=NULL
  WHERE operation_id=NEW.operation_id;
END;

CREATE TRIGGER IF NOT EXISTS v3_operation_summaries_after_pin_update
AFTER UPDATE OF pinned ON v3_operations
BEGIN
  UPDATE v3_operation_summaries SET pinned=NEW.pinned WHERE operation_id=NEW.operation_id;
END;
`

interface SummaryWhere {
  sql: string
  params: Array<unknown>
}

const LIKE_ESCAPE = String.fromCodePoint(92)

function escapeLike(value: string): string {
  return value.replaceAll(LIKE_ESCAPE, LIKE_ESCAPE.repeat(2)).replaceAll("%", `${LIKE_ESCAPE}%`).replaceAll("_", `${LIKE_ESCAPE}_`)
}

function compileSummaryWhere(options: QueryOptions): SummaryWhere {
  const terms = ["projection_status='ready'"]
  const params: Array<unknown> = []
  const kind = options.operationKind ?? "generation"
  if (kind === "generation") {
    terms.push("operation_kind IN ('generation','responses_ws')")
  } else if (kind !== "all") {
    terms.push("operation_kind=?")
    params.push(kind)
  }
  if (options.model) {
    terms.push(`(lower(request_model) LIKE ? ESCAPE '${LIKE_ESCAPE}' OR lower(response_model) LIKE ? ESCAPE '${LIKE_ESCAPE}')`)
    const needle = `%${escapeLike(options.model.toLowerCase())}%`
    params.push(needle, needle)
  }
  if (options.endpoint) {
    terms.push("endpoint=?")
    params.push(options.endpoint)
  }
  if (options.state) {
    terms.push("state=?")
    params.push(options.state)
  } else if (options.success !== undefined) {
    terms.push(options.success ? "state='completed'" : "state='failed'")
  }
  if (options.from !== undefined) {
    terms.push("started_at>=?")
    params.push(options.from)
  }
  if (options.to !== undefined) {
    terms.push("started_at<=?")
    params.push(options.to)
  }
  if (options.sessionId) {
    terms.push("session_id=?")
    params.push(options.sessionId)
  }
  if (options.agentId) {
    terms.push("agent_id=?")
    params.push(options.agentId)
  } else if (options.mainAgentOnly) {
    terms.push("agent_id IS NULL")
  }
  if (options.pid !== undefined) {
    terms.push("pid=?")
    params.push(options.pid)
  }
  return { sql: terms.join(" AND "), params }
}

function parseSummaryJson(row: { summary_json: string; pinned: number }): EntrySummary {
  return { ...(JSON.parse(row.summary_json) as EntrySummary), active: false, pinned: row.pinned === 1 }
}

export function getPersistedSummary(db: Database, operationId: string): EntrySummary | undefined {
  const row = db.prepare("SELECT summary_json,pinned FROM v3_operation_summaries WHERE operation_id=? AND projection_status='ready'").get(operationId) as
    | { summary_json: string; pinned: number }
    | undefined
  return row ? parseSummaryJson(row) : undefined
}

export function hasPersistedSummaryMatching(db: Database, operationId: string, options: QueryOptions): boolean {
  const where = compileSummaryWhere(options)
  return Boolean(db.prepare(`SELECT 1 FROM v3_operation_summaries WHERE operation_id=? AND ${where.sql} LIMIT 1`).get(operationId, ...where.params))
}

function summaryPageIndex(options: QueryOptions): string {
  const kind = options.operationKind ?? "generation"
  return kind === "all" || kind === "generation" ? "idx_v3_operation_summaries_created" : "idx_v3_operation_summaries_kind_created"
}

function summaryPageSql(options: QueryOptions, where: SummaryWhere, boundary: string, order: string, explain = false): string {
  const prefix = explain ? "EXPLAIN QUERY PLAN " : ""
  return `${prefix}SELECT summary_json,pinned FROM v3_operation_summaries INDEXED BY ${summaryPageIndex(options)} WHERE ${where.sql}${boundary} ORDER BY ${order} LIMIT ?`
}

export function explainSummaryPagePlan(db: Database, options: QueryOptions, limit: number): Array<string> {
  const where = compileSummaryWhere(options)
  const order = options.direction === "newer" ? "started_at ASC,operation_id ASC" : "started_at DESC,operation_id DESC"
  return (db.prepare(summaryPageSql(options, where, "", order, true)).all(...where.params, limit) as Array<{ detail: string }>).map((row) => row.detail)
}

export function querySummaryPage(db: Database, options: QueryOptions, limit: number, cursorSummary?: EntrySummary): SummaryResult {
  const where = compileSummaryWhere(options)
  const cursor = cursorSummary ?? (options.cursor ? getPersistedSummary(db, options.cursor) : undefined)
  if (options.cursor && !cursor) throw new Error(`Unknown summary cursor: ${options.cursor}`)
  const direction = options.direction ?? "older"
  let boundary = ""
  if (cursor) {
    boundary = direction === "newer" ? " AND (started_at>? OR (started_at=? AND operation_id>?))" : " AND (started_at<? OR (started_at=? AND operation_id<?))"
  }
  const boundaryParams = cursor ? [cursor.startedAt, cursor.startedAt, cursor.id] : []
  const order = direction === "newer" ? "started_at ASC,operation_id ASC" : "started_at DESC,operation_id DESC"
  const rows = db.prepare(summaryPageSql(options, where, boundary, order)).all(...where.params, ...boundaryParams, Math.max(0, limit)) as Array<{
    summary_json: string
    pinned: number
  }>
  const entries = rows.map((row) => parseSummaryJson(row))
  if (direction === "newer") entries.reverse()
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM v3_operation_summaries WHERE ${where.sql}`).get(...where.params) as { n: number }).n

  const newest = entries.at(0)
  const oldest = entries.at(-1)
  let hasNewer = false
  if (newest) {
    hasNewer = Boolean(
      db
        .prepare(`SELECT 1 FROM v3_operation_summaries WHERE ${where.sql} AND (started_at>? OR (started_at=? AND operation_id>?)) LIMIT 1`)
        .get(...where.params, newest.startedAt, newest.startedAt, newest.id),
    )
  }
  let hasOlder = false
  if (oldest) {
    hasOlder = Boolean(
      db
        .prepare(`SELECT 1 FROM v3_operation_summaries WHERE ${where.sql} AND (started_at<? OR (started_at=? AND operation_id<?)) LIMIT 1`)
        .get(...where.params, oldest.startedAt, oldest.startedAt, oldest.id),
    )
  }
  let nextCursor: string | null = null
  if (hasOlder && oldest) nextCursor = oldest.id
  let prevCursor: string | null = null
  if (hasNewer && newest) prevCursor = newest.id
  return { entries, total, nextCursor, prevCursor }
}

export interface SummaryProjectionReadiness {
  ready: boolean
  pending: number
  poisoned: number
}

export function isSummaryProjectionReady(db: Database): boolean {
  return getMeta(db, SUMMARY_PROJECTION_READY_KEY) === "1"
}

export function getSummaryProjectionReadiness(db: Database): SummaryProjectionReadiness {
  const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='v3_operation_summaries'").get()
  if (!table) return { ready: false, pending: 0, poisoned: 0 }
  const statuses = db
    .prepare(
      `SELECT
         SUM(CASE WHEN projection_status='pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN projection_status='poisoned' THEN 1 ELSE 0 END) AS poisoned
       FROM v3_operation_summaries`,
    )
    .get() as { pending: number | null; poisoned: number | null }
  return {
    ready: getMeta(db, SUMMARY_PROJECTION_READY_KEY) === "1",
    pending: statuses.pending ?? 0,
    poisoned: statuses.poisoned ?? 0,
  }
}

export function backfillExistingSummaryRows(db: Database, limit: number): number {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO v3_operation_summaries(${projectionColumns})
       SELECT ${historicalProjectionValues}
       FROM v3_operations
       WHERE NOT EXISTS (
         SELECT 1 FROM v3_operation_summaries
         WHERE v3_operation_summaries.operation_id=v3_operations.operation_id
       )
       ORDER BY created_at,operation_id
       LIMIT ?`,
    )
    .run(limit)
  return result.changes
}

export function markSummaryProjectionPoisoned(db: Database, operationId: string, reason: string): void {
  db.prepare(
    `UPDATE v3_operation_summaries
     SET projection_status='poisoned',projection_error=?
     WHERE operation_id=? AND projection_status<>'ready'`,
  ).run(reason, operationId)
}

export function tryMarkSummaryProjectionReady(db: Database): SummaryProjectionReadiness {
  db.exec("BEGIN IMMEDIATE")
  try {
    const divergence = db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT o.operation_id
           FROM v3_operations o
           LEFT JOIN v3_operation_summaries s ON s.operation_id=o.operation_id
           WHERE s.operation_id IS NULL OR NOT (${projectionEquality})
           UNION ALL
           SELECT s.operation_id
           FROM v3_operation_summaries s
           LEFT JOIN v3_operations o ON o.operation_id=s.operation_id
           WHERE o.operation_id IS NULL
         )`,
      )
      .get() as { n: number }
    const statuses = db
      .prepare(
        `SELECT
           SUM(CASE WHEN projection_status='pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN projection_status='poisoned' THEN 1 ELSE 0 END) AS poisoned,
           SUM(CASE WHEN projection_status<>'ready' THEN 1 ELSE 0 END) AS not_ready
         FROM v3_operation_summaries`,
      )
      .get() as { pending: number | null; poisoned: number | null; not_ready: number | null }
    const pending = statuses.pending ?? 0
    const poisoned = statuses.poisoned ?? 0
    const ready = divergence.n === 0 && (statuses.not_ready ?? 0) === 0
    if (ready) {
      if (getMeta(db, SUMMARY_PROJECTION_READY_KEY) !== "1") setMeta(db, SUMMARY_PROJECTION_READY_KEY, "1")
    } else {
      deleteMeta(db, SUMMARY_PROJECTION_READY_KEY)
    }
    db.exec("COMMIT")
    return { ready, pending, poisoned }
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // Preserve the gate error when SQLite already rolled the transaction back.
    }
    throw error
  }
}
