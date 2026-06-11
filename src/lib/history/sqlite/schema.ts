export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries_v2 (
  id               TEXT PRIMARY KEY,
  session_id       TEXT,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  duration_ms      INTEGER,
  model            TEXT,
  endpoint         TEXT,
  transport        TEXT,
  status           TEXT NOT NULL,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cache_read       INTEGER,
  cache_creation   INTEGER,
  reasoning_tokens INTEGER,
  stop_reason      TEXT,
  error_message    TEXT,
  message_count    INTEGER,
  preview_text     TEXT,
  search_text      TEXT,
  pid              INTEGER,
  boot_time        INTEGER,
  git_sha          TEXT,
  blob_gz          BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_v2_started_at ON entries_v2(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_v2_session    ON entries_v2(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_v2_model      ON entries_v2(model, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_v2_status     ON entries_v2(status, started_at DESC);
-- NOTE: idx_entries_v2_pid is intentionally NOT created here. On an existing
-- (pre-pid) database, openDatabase runs this SCHEMA_SQL *before* the column
-- migration, so a CREATE INDEX on the not-yet-added pid column would fail.
-- The pid index is created inside migrateEntriesColumns, after the ALTER.

CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  start_time           INTEGER NOT NULL,
  last_activity        INTEGER NOT NULL,
  request_count        INTEGER NOT NULL DEFAULT 0,
  total_input_tokens   INTEGER NOT NULL DEFAULT 0,
  total_output_tokens  INTEGER NOT NULL DEFAULT 0,
  models_json          TEXT,
  endpoints_json       TEXT,
  tools_used_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC);

CREATE TABLE IF NOT EXISTS response_sessions (
  response_id TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL
);

-- Per-stage / per-attempt heavy blobs, split out of the entries_v2 head row.
-- One head row (entries_v2) has 0..N stage rows here. Keeping the heavy
-- payloads in a SEPARATE table (not extra rows in entries_v2) is what lets
-- reaper bucketing, stats COUNT/SUM, cursor pagination, and session aggregate
-- recompute keep operating on entries_v2 as "one row per request" unchanged.
--
-- stage: 'inbound_request' | 'effective_request' | 'outbound_request'
--      | 'outbound_response' | 'inbound_response' | 'sse_events'
-- attempt_index: -1 for leg-independent stages (inbound_request, inbound_response,
--   sse_events); 0..N for per-attempt stages (effective/outbound_request/response).
-- ON DELETE CASCADE: a reaper / deleteSession / clearAll DELETE on the head row
--   auto-removes its stage rows (PRAGMA foreign_keys = ON is set at open time).
CREATE TABLE IF NOT EXISTS entry_stages (
  entry_id      TEXT NOT NULL,
  stage         TEXT NOT NULL,
  attempt_index INTEGER NOT NULL DEFAULT -1,
  created_at    INTEGER NOT NULL,
  blob_gz       BLOB NOT NULL,
  PRIMARY KEY (entry_id, stage, attempt_index),
  FOREIGN KEY (entry_id) REFERENCES entries_v2(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_entry_stages_entry ON entry_stages(entry_id);
`
