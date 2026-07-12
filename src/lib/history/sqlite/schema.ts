/**
 * Single-source DDL for the `history_meta` key/value table. Shared by SCHEMA_SQL
 * (the openDatabase floor) and HistoryMetaStorage's bare-DB guard (the migration
 * runner) so the two definitions can never drift apart.
 */
export const HISTORY_META_DDL = `CREATE TABLE IF NOT EXISTS history_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
)`

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries_v2 (
  id               TEXT PRIMARY KEY,
  session_id       TEXT,
  agent_id         TEXT,
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
  usage_normalized INTEGER NOT NULL DEFAULT 0,
  stages_migrated  INTEGER NOT NULL DEFAULT 0,
  cache_write_backfilled INTEGER NOT NULL DEFAULT 0,
  stop_reason      TEXT,
  error_message    TEXT,
  message_count    INTEGER,
  preview_text     TEXT,
  response_preview_text TEXT,
  pid              INTEGER,
  boot_time        INTEGER,
  git_sha          TEXT,
  pinned           INTEGER NOT NULL DEFAULT 0,
  request_bytes    INTEGER,
  response_bytes   INTEGER,
  multiplier       REAL,
  blob_gz          BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_v2_started_at ON entries_v2(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_v2_session    ON entries_v2(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_v2_model      ON entries_v2(model, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_v2_status     ON entries_v2(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_v2_endpoint   ON entries_v2(endpoint, started_at DESC);
-- NOTE: idx_entries_v2_pid AND idx_entries_v2_active are intentionally NOT
-- created here. Both reference the pid column, and on an existing (pre-pid)
-- database openDatabase runs this SCHEMA_SQL *before* the column migration, so a
-- CREATE INDEX on the not-yet-added pid column would fail. Both are created
-- inside migrateEntriesColumns, after the ALTER.

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
--      | 'client_request' | 'client_response' | 'effective_source'
--      | 'upstream_request' | 'upstream_response'  (new client/upstream legs, RFC §3)
-- attempt_index: -1 for leg-independent stages (inbound_request, inbound_response,
--   sse_events, client_request, client_response); 0..N for per-attempt stages
--   (effective/outbound_request/response, effective_source/upstream_request/upstream_response).
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

-- ============================================================================
-- search_index (content-addressed message dedup search — RFC search-index)
-- ============================================================================
-- msg_blob: each DISTINCT normalized message stored ONCE, keyed by its
--   content hash (git-blob style). Cross-turn dedup: a message that recurs
--   across N requests is one row. Collision → INSERT OR IGNORE keeps the first
--   writer's text (content-defined invariant). No FK — shared across requests,
--   reclaimed by the orphan GC (NOT EXISTS over req_msg) when no req_msg points
--   at it.
CREATE TABLE IF NOT EXISTS msg_blob (
  hash TEXT PRIMARY KEY,
  text TEXT NOT NULL
);
-- req_msg: which messages (by position) each request references. ON DELETE
--   CASCADE from entries_v2 — a reaper / deleteSession / clearAll head delete
--   auto-removes the request's rows (orphan GC then sweeps now-unreferenced
--   msg_blob rows).
CREATE TABLE IF NOT EXISTS req_msg (
  req_id TEXT NOT NULL,
  pos    INTEGER NOT NULL,
  hash   TEXT NOT NULL,
  PRIMARY KEY (req_id, pos),
  FOREIGN KEY (req_id) REFERENCES entries_v2(id) ON DELETE CASCADE
);
-- Serves hash→request lookup (search) AND the orphan-GC NOT EXISTS probe.
CREATE INDEX IF NOT EXISTS idx_req_msg_hash ON req_msg(hash);
-- req_aux: flat per-request searchable text for the four non-inbound facets
--   (rewrites-req / rewrites-resp / req-headers / resp-headers). NOT
--   content-addressed (per-request, rarely identical across requests). One row
--   per (req_id, source). CASCADE from entries_v2.
CREATE TABLE IF NOT EXISTS req_aux (
  req_id TEXT NOT NULL,
  source TEXT NOT NULL,
  text   TEXT NOT NULL,
  PRIMARY KEY (req_id, source),
  FOREIGN KEY (req_id) REFERENCES entries_v2(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_req_aux_src ON req_aux(source);
-- history_meta: migration guard (search_index_version) + backfill cursor.
${HISTORY_META_DDL};
`
