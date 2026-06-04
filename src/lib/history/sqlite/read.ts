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
  deserializeEntry,
  type EntryRow,
} from "./serialize"

/** Portable bind-parameter type for SQLite (matches better-sqlite3 and bun:sqlite). */
type SqlBinding = string | number | bigint | Buffer | null

interface WhereClause {
  sql: string
  params: Array<SqlBinding>
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
  if (opts?.success === true) {
    where.push("status = ?")
    params.push("completed")
  } else if (opts?.success === false) {
    where.push("status = ?")
    params.push("failed")
  }
  if (opts?.search) {
    where.push("(search_text LIKE ? OR preview_text LIKE ?)")
    const pattern = `%${opts.search}%`
    params.push(pattern, pattern)
  }
  const sql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
  return { sql, params }
}

export function queryEntries(opts?: QueryOptions): Array<HistoryEntry> {
  const db = getDatabase()
  const { sql, params } = applyWhere(opts)
  const limit = opts?.limit ?? 100
  const rows = db
    .prepare(`SELECT * FROM entries ${sql} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, 0) as Array<EntryRow>
  return rows.map((r) => deserializeEntry(r))
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
              message_count, preview_text, search_text
         FROM entries ${sql} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
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
  const row = db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as EntryRow | undefined
  if (!row) return undefined
  return deserializeEntry(row)
}

export function queryEntryCount(opts?: QueryOptions): number {
  const db = getDatabase()
  const { sql, params } = applyWhere(opts)
  const row = db.prepare(`SELECT COUNT(*) AS n FROM entries ${sql}`).get(...params) as { n: number }
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
  const row = db.prepare("SELECT session_id FROM response_sessions WHERE response_id = ?").get(responseId) as
    | { session_id: string }
    | undefined
  return row?.session_id
}
