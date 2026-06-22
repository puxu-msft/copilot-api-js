import type {
  //
  EntrySummary,
  HistoryEntry,
  QueryOptions,
  Session,
} from "~/lib/history/types"

import { getDatabase } from "./connection"
import {
  //
  assembleFullEntry,
  type EntryRow,
  type StageRow,
} from "./serialize"

/** Portable bind-parameter type for SQLite (matches better-sqlite3 and bun:sqlite). */
type SqlBinding = string | number | bigint | Buffer | null

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

/**
 * FTS5 minimum needle length. The trigram tokenizer indexes 3-character grams,
 * so a MATCH needle shorter than 3 chars can't be served by the index — those
 * fall back to a LIKE scan (rare, and cheap on the short tail of short queries).
 */
const FTS_MIN_NEEDLE = 3

/** Wrap a needle as an FTS5 string literal (double-quote + escape inner quotes) so trigram does a substring match and special chars stay literal. */
function ftsLiteral(needle: string): string {
  return `"${needle.replaceAll('"', '""')}"`
}

function applyWhere(opts: QueryOptions | undefined): WhereClause {
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
    // Substring search via the trigram FTS index for ≥3-char needles
    // (index-backed, scales with retention); LIKE fallback for the short tail
    // the trigram tokenizer can't index. Both branches are case-insensitive
    // substring matches; they match identically for ASCII, but differ for
    // non-ASCII text — the trigram tokenizer case-folds full Unicode whereas
    // SQLite's LIKE only folds ASCII A–Z. So the ≥3-char path is a (slight)
    // superset of the old LIKE-only behavior for accented/Cyrillic/Greek text;
    // this is an improvement, not a regression.
    if (opts.search.length >= FTS_MIN_NEEDLE) {
      where.push("rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?)")
      params.push(ftsLiteral(opts.search))
    } else {
      where.push("(search_text LIKE ? OR preview_text LIKE ?)")
      const pattern = `%${opts.search}%`
      params.push(pattern, pattern)
    }
  }
  if (opts?.pid !== undefined) {
    where.push("pid = ?")
    params.push(opts.pid)
  }
  const sql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
  return { sql, params }
}

export function queryEntries(opts?: QueryOptions): Array<HistoryEntry> {
  const db = getDatabase()
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
  const db = getDatabase()
  const { sql, params } = applyWhere(opts)
  const limit = opts?.limit ?? 100
  const rows = db
    .prepare(
      `SELECT id, session_id, started_at, ended_at, duration_ms,
              model, endpoint, transport, status,
              input_tokens, output_tokens, cache_read, cache_creation, reasoning_tokens,
              stop_reason, error_message,
              message_count, preview_text, search_text, pid
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
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    endpoint: r.endpoint as EntrySummary["endpoint"],
    state: (r.status as EntrySummary["state"]) ?? undefined,
    active: false,
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
    previewText: r.preview_text ?? "",
    searchText: r.search_text ?? "",
  }
}

export function getEntryById(id: string): HistoryEntry | undefined {
  const db = getDatabase()
  const row = db.prepare("SELECT * FROM entries_v2 WHERE id = ?").get(id) as EntryRow | undefined
  if (!row) return undefined
  const stages = loadStagesFor(db, [id]).get(id) ?? []
  return assembleFullEntry(row, stages)
}

export function queryEntryCount(opts?: QueryOptions): number {
  const db = getDatabase()
  const { sql, params } = applyWhere(opts)
  const row = db.prepare(`SELECT COUNT(*) AS n FROM entries_v2 ${sql}`).get(...params) as { n: number }
  return row.n
}

interface SessionRow {
  id: string
  start_time: number
  last_activity: number
  request_count: number
  total_input_tokens: number
  total_output_tokens: number
  models_json: string | null
  endpoints_json: string | null
  tools_used_json: string | null
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    startTime: r.start_time,
    lastActivity: r.last_activity,
    requestCount: r.request_count,
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
    models: r.models_json ? (JSON.parse(r.models_json) as Array<string>) : [],
    endpoints: r.endpoints_json ? (JSON.parse(r.endpoints_json) as Session["endpoints"]) : [],
    toolsUsed: r.tools_used_json ? (JSON.parse(r.tools_used_json) as Array<string>) : undefined,
  }
}

export function listSessions(): Array<Session> {
  const db = getDatabase()
  const rows = db.prepare("SELECT * FROM sessions ORDER BY last_activity DESC").all() as Array<SessionRow>
  return rows.map((r) => rowToSession(r))
}

export function getSessionById(id: string): Session | undefined {
  const db = getDatabase()
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined
  return row ? rowToSession(row) : undefined
}

export function resolveResponseSession(responseId: string): string | undefined {
  const db = getDatabase()
  const row = db.prepare("SELECT session_id FROM response_sessions WHERE response_id = ?").get(responseId) as { session_id: string } | undefined
  return row?.session_id
}
