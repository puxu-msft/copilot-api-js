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
  blob_gz          BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_v2_started_at ON entries_v2(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_v2_session    ON entries_v2(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_v2_model      ON entries_v2(model, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_v2_status     ON entries_v2(status, started_at DESC);

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
`
