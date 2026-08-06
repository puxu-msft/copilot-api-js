import type { Database } from "~/lib/history/sqlite/connection"

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

export interface SummaryProjectionReadiness {
  ready: boolean
  pending: number
  poisoned: number
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
