import type {
  //
  EntrySummary,
  HistoryEntry,
  QueryOptions,
} from "~/lib/history/types"

import { getArchiveDb } from "./archive-db"
import { getDatabase } from "./connection"
import {
  //
  assembleFullEntry,
  type EntryRow,
  type StageRow,
} from "./serialize"

/** Portable bind-parameter type for SQLite (matches better-sqlite3 and bun:sqlite). */
type SqlBinding = string | number | bigint | Buffer | null

/**
 * Resolve which physical DB a read hits from the view-domain selector (spec §2/§4).
 * `tier="archive"` reads the archive connection (its own entries_v2 = tier-1 rows);
 * everything else (default) reads the HOT store. The SAME SQL runs against either
 * connection — the archive.db is built from the identical schema — so no query
 * needs schema-qualified table names. The two views NEVER co-list.
 */
function resolveReadDb(tier: QueryOptions["tier"]): ReturnType<typeof getDatabase> {
  return tier === "archive" ? getArchiveDb() : getDatabase()
}

/** Batch-load stage rows for a set of entry ids, grouped by entry_id (avoids N+1). */
function loadStagesFor(db: ReturnType<typeof getDatabase>, ids: Array<string>): Map<string, Array<StageRow>> {
  const map = new Map<string, Array<StageRow>>()
  if (ids.length === 0) return map
  const placeholders = ids.map(() => "?").join(",")
  const rows = db
    .prepare(`SELECT entry_id, stage, attempt_index, created_at, blob_gz FROM entry_stages WHERE entry_id IN (${placeholders})`)
    .all(...ids) as Array<StageRow>
  for (const r of rows) {
    const list = map.get(r.entry_id)
    if (list) list.push(r)
    else map.set(r.entry_id, [r])
  }
  return map
}

interface WhereClause {
  sql: string
  params: Array<SqlBinding>
}

export function applyWhere(opts: QueryOptions | undefined): WhereClause {
  const where: Array<string> = []
  const params: Array<SqlBinding> = []
  if (opts?.model) {
    where.push("model LIKE ?")
    params.push(`%${opts.model}%`)
  }
  if (opts?.endpoint) {
    where.push("endpoint = ?")
    params.push(opts.endpoint)
  }
  if (opts?.sessionId) {
    where.push("session_id = ?")
    params.push(opts.sessionId)
  }
  // agentId wins over mainAgentOnly when both set (mutually exclusive per the type).
  if (opts?.agentId) {
    where.push("agent_id = ?")
    params.push(opts.agentId)
  } else if (opts?.mainAgentOnly) {
    where.push("agent_id IS NULL")
  }
  if (opts?.from !== undefined) {
    where.push("started_at >= ?")
    params.push(opts.from)
  }
  if (opts?.to !== undefined) {
    where.push("started_at <= ?")
    params.push(opts.to)
  }
  // `state` is the granular filter (exact status); `success` is the coarse
  // completed-vs-failed one. When `state` is given it wins (skip `success`).
  if (opts?.state) {
    where.push("status = ?")
    params.push(opts.state)
  } else if (opts?.success === true) {
    where.push("status = ?")
    params.push("completed")
  } else if (opts?.success === false) {
    where.push("status = ?")
    params.push("failed")
  }
  if (opts?.search) {
    // List inline filter is a FAST, preview-only substring match (RFC P2/v5): the
    // list is a quick "as-you-type" filter over the denormalized preview, NOT a
    // deep full-text search. Deep full-text (5 facets) lives at /api/search over
    // the content-addressed index. The trigram FTS is no longer read here (it is
    // dead-read at P2, dropped at P3); there is deliberately NO FTS fallback.
    where.push("(preview_text LIKE ? OR response_preview_text LIKE ?)")
    params.push(`%${opts.search}%`, `%${opts.search}%`)
  }
  if (opts?.pid !== undefined) {
    where.push("pid = ?")
    params.push(opts.pid)
  }
  const sql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
  return { sql, params }
}

export function queryEntries(opts?: QueryOptions): Array<HistoryEntry> {
  const db = resolveReadDb(opts?.tier)
  const { sql, params } = applyWhere(opts)
  const limit = opts?.limit ?? 100
  const rows = db.prepare(`SELECT * FROM entries_v2 ${sql} ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...params, limit, 0) as Array<EntryRow>
  const stagesById = loadStagesFor(
    db,
    rows.map((r) => r.id),
  )
  return rows.map((r) => assembleFullEntry(r, stagesById.get(r.id) ?? []))
}

type SummaryRow = Omit<EntryRow, "blob_gz">

export function querySummaries(opts?: QueryOptions): Array<EntrySummary> {
  const db = resolveReadDb(opts?.tier)
  const { sql, params } = applyWhere(opts)
  const limit = opts?.limit ?? 100
  const rows = db
    .prepare(
      `SELECT id, session_id, agent_id, started_at, ended_at, duration_ms,
              model, endpoint, raw_path, transport, status,
              input_tokens, output_tokens, cache_read, cache_creation, reasoning_tokens,
              stop_reason, error_message,
              message_count, preview_text, response_preview_text, pid, pinned,
              request_bytes, response_bytes, multiplier
         FROM entries_v2 ${sql} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, 0) as Array<SummaryRow>
  return rows.map((r) => rowToSummary(r))
}

function statusToResponseSuccess(status: string): boolean | undefined {
  if (status === "completed") return true
  if (status === "failed") return false
  return undefined
}

function rowToSummary(r: SummaryRow): EntrySummary {
  const hasUsage = r.input_tokens !== null || r.output_tokens !== null
  const responseSuccess = statusToResponseSuccess(r.status)
  return {
    id: r.id,
    sessionId: r.session_id ?? undefined,
    agentId: r.agent_id ?? undefined,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    endpoint: r.endpoint as EntrySummary["endpoint"],
    rawPath: r.raw_path ?? undefined,
    state: (r.status as EntrySummary["state"]) ?? undefined,
    active: false,
    pinned: r.pinned === 1,
    lastUpdatedAt: r.ended_at ?? r.started_at,
    pid: r.pid ?? undefined,
    requestModel: r.model ?? undefined,
    responseModel: r.model ?? undefined,
    responseSuccess,
    responseError: r.error_message ?? undefined,
    messageCount: r.message_count ?? 0,
    usage:
      hasUsage ?
        {
          input_tokens: r.input_tokens ?? 0,
          output_tokens: r.output_tokens ?? 0,
          cache_read_input_tokens: r.cache_read ?? undefined,
          cache_creation_input_tokens: r.cache_creation ?? undefined,
        }
      : undefined,
    durationMs: r.duration_ms ?? undefined,
    requestBytes: r.request_bytes ?? undefined,
    responseBytes: r.response_bytes ?? undefined,
    multiplier: r.multiplier ?? undefined,
    previewText: r.preview_text ?? "",
    responsePreviewText: r.response_preview_text ?? "",
  }
}

/**
 * Load lightweight summaries for a set of ids, keyed by id (no head-blob decode).
 * Used by the dedicated search path to attach an `EntrySummary` to each result.
 */
export function loadSummariesByIds(ids: Array<string>, db: ReturnType<typeof getDatabase> = getDatabase()): Map<string, EntrySummary> {
  const map = new Map<string, EntrySummary>()
  if (ids.length === 0) return map
  const placeholders = ids.map(() => "?").join(",")
  const rows = db
    .prepare(
      `SELECT id, session_id, agent_id, started_at, ended_at, duration_ms,
              model, endpoint, raw_path, transport, status,
              input_tokens, output_tokens, cache_read, cache_creation, reasoning_tokens,
              stop_reason, error_message,
              message_count, preview_text, response_preview_text, pid, pinned,
              request_bytes, response_bytes, multiplier
         FROM entries_v2 WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<SummaryRow>
  for (const row of rows) map.set(row.id, rowToSummary(row))
  return map
}

export function getEntryById(id: string, tier?: QueryOptions["tier"]): HistoryEntry | undefined {
  const db = resolveReadDb(tier)
  const row = db.prepare("SELECT * FROM entries_v2 WHERE id = ?").get(id) as EntryRow | undefined
  if (!row) return undefined
  const stages = loadStagesFor(db, [id]).get(id) ?? []
  return assembleFullEntry(row, stages)
}

export function queryEntryCount(opts?: QueryOptions): number {
  const db = resolveReadDb(opts?.tier)
  const { sql, params } = applyWhere(opts)
  const row = db.prepare(`SELECT COUNT(*) AS n FROM entries_v2 ${sql}`).get(...params) as { n: number }
  return row.n
}

export function resolveResponseSession(responseId: string): string | undefined {
  const db = getDatabase()
  const row = db.prepare("SELECT session_id FROM response_sessions WHERE response_id = ?").get(responseId) as { session_id: string } | undefined
  return row?.session_id
}
