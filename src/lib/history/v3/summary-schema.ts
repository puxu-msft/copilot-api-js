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
 * post-convergence direct writer. This dependency-free schema leaf is shared by
 * the migration registry and the runtime projection store without coupling the
 * migration graph back to the database connection lifecycle.
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

export const projectionColumns = SUMMARY_PROJECTION_FIELDS.map((field) => field.column).join(",")
export const newProjectionValues = SUMMARY_PROJECTION_FIELDS.map((field) => field.source("NEW")).join(",")
export const readyAssignments = SUMMARY_PROJECTION_FIELDS.filter(
  (field) => !["operation_id", "pinned", "projection_error", "projection_status"].includes(field.column),
)
  .map((field) => `${field.column}=${field.source("NEW")}`)
  .join(",")

export const historicalProjectionValues = SUMMARY_PROJECTION_FIELDS.map((field) => field.source("v3_operations")).join(",")
export const projectionEquality = SUMMARY_PROJECTION_FIELDS.filter((field) => !["operation_id", "projection_error", "projection_status"].includes(field.column))
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
