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
CREATE INDEX IF NOT EXISTS idx_entries_v2_endpoint   ON entries_v2(endpoint, started_at DESC);
-- NOTE: idx_entries_v2_pid AND idx_entries_v2_active are intentionally NOT
-- created here. Both reference the pid column, and on an existing (pre-pid)
-- database openDatabase runs this SCHEMA_SQL *before* the column migration, so a
-- CREATE INDEX on the not-yet-added pid column would fail. Both are created
-- inside migrateEntriesColumns, after the ALTER.

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

-- Per-entry lineage digest. See docs/rfc/request-lineage.md §4.1.
--
-- One row per entry (FOREIGN KEY ... ON DELETE CASCADE — bucket reaper
-- automatically cleans these when an entry is dropped).
--
-- turn_hashes_blob is packed 32-byte raw SHA-256s (~50% size vs JSON-of-hex).
-- post_response_hash is NULL when the entry is failed/interrupted (cannot
-- serve as a parent in the lineage, can still be a child).
-- back_tool_use_id is NULL when the tail message has no tool_result block
-- (pure-text turn, ~1% of completed Claude Code traffic per RFC §2.3).
CREATE TABLE IF NOT EXISTS entry_lineage (
  entry_id            TEXT PRIMARY KEY,
  schema_version      INTEGER NOT NULL,
  root_hash           TEXT NOT NULL,
  turn_hashes_blob    BLOB NOT NULL,
  post_response_hash  TEXT,
  back_tool_use_id    TEXT,
  computed_at         INTEGER NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES entries_v2(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_entry_lineage_post ON entry_lineage(post_response_hash);
CREATE INDEX IF NOT EXISTS idx_entry_lineage_root ON entry_lineage(root_hash);
CREATE INDEX IF NOT EXISTS idx_entry_lineage_back ON entry_lineage(back_tool_use_id);

-- Reverse-index for O(1) parent lookup by tool_use_id. Composite PK
-- accepts the (vanishingly rare) case of upstream replaying an id across
-- entries; idx_produced_tool_only serves the single-column equality
-- lookup that the parent query hits.
CREATE TABLE IF NOT EXISTS entry_produced_tool_ids (
  tool_use_id  TEXT NOT NULL,
  entry_id     TEXT NOT NULL,
  PRIMARY KEY (tool_use_id, entry_id),
  FOREIGN KEY (entry_id) REFERENCES entries_v2(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_produced_tool_only  ON entry_produced_tool_ids(tool_use_id);
CREATE INDEX IF NOT EXISTS idx_produced_tool_entry ON entry_produced_tool_ids(entry_id);
`

/**
 * Trigram FTS5 search index over the entry summary text, executed SEPARATELY
 * from SCHEMA_SQL (see connection.ts `ensureSearchIndex`) because it must run
 * AFTER `migrateEntriesColumns` — on a pre-summary-column database the
 * `search_text` / `preview_text` columns it references don't exist until the
 * ALTER adds them, and the AFTER-write triggers below reference `new.search_text`.
 *
 * Design:
 *   - **trigram tokenizer** makes `MATCH '"substring"'` behave like
 *     `LIKE '%substring%'` (for ≥3-char needles) but index-backed instead of a
 *     full table scan — preserving the substring-search semantics the UI relied
 *     on. Sub-3-char needles fall back to LIKE in read.ts (trigram needs ≥3 chars).
 *   - **external-content** (`content='entries_v2'`): the FTS index stores only
 *     trigrams, NOT a second copy of the text — it reads the original from
 *     entries_v2 via `rowid`. Keeps the index compact.
 *   - **sync triggers**: external-content FTS is NOT auto-maintained. These fire
 *     on EVERY write path — including raw-SQL deletes (reaper eviction,
 *     deleteSession, clearAll) and the eager-persistence head upserts (which fire
 *     AFTER UPDATE) — so the index stays consistent without routing every write
 *     through TS. The `'delete'` command needs the OLD column values to locate
 *     and remove the row's trigrams (external-content delete contract).
 *
 * Rowid coupling caveat: entries_v2 has a TEXT primary key, so its `rowid` is
 * the implicit integer rowid — which a full `VACUUM` can RENUMBER. After any
 * VACUUM the external-content index must be rebuilt (see connection.ts).
 */
export const FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  search_text, preview_text,
  content='entries_v2', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS entries_v2_fts_ai AFTER INSERT ON entries_v2 BEGIN
  INSERT INTO entries_fts(rowid, search_text, preview_text) VALUES (new.rowid, new.search_text, new.preview_text);
END;
CREATE TRIGGER IF NOT EXISTS entries_v2_fts_ad AFTER DELETE ON entries_v2 BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, search_text, preview_text) VALUES ('delete', old.rowid, old.search_text, old.preview_text);
END;
CREATE TRIGGER IF NOT EXISTS entries_v2_fts_au AFTER UPDATE ON entries_v2 BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, search_text, preview_text) VALUES ('delete', old.rowid, old.search_text, old.preview_text);
  INSERT INTO entries_fts(rowid, search_text, preview_text) VALUES (new.rowid, new.search_text, new.preview_text);
END;
`
