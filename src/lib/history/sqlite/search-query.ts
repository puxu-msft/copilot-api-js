/**
 * Dedicated full-text search over the content-addressed search_index (RFC P2).
 *
 * Two facet families:
 *   - `inbound` — content-addressed messages. A LIKE over `msg_blob.text` yields
 *     matching hashes; each hash collapses to ONE result row owned by the EARLIEST
 *     (min started_at) request referencing it ("eliminate previous" dedup). The
 *     snippet is computed in JS (LIKE proves existence, not offset).
 *   - `rewrites-req` / `rewrites-resp` / `req-headers` / `resp-headers` — flat
 *     per-request `req_aux` text; a LIKE yields one row per matching request.
 *
 * Structural filters (model / status / session / agent / pid / time) are applied
 * by joining `entries_v2` and reusing the same predicates as the list read.
 * Pagination is keyset by `(started_at DESC, ownerKey ASC)` so it is stable while
 * the reaper evicts rows underneath it.
 */

import type {
  //
  QueryOptions,
  SearchResultRow,
  SearchSource,
} from "~/lib/history/types"

import type { Database } from "./connection"

import { loadSummariesByIds } from "./read"

/** Default page size for a search request. */
const DEFAULT_SEARCH_LIMIT = 30

/** Characters around the first match included in a snippet window. */
const SNIPPET_RADIUS = 80

/** Escape LIKE wildcards so a user needle is matched literally (paired with `ESCAPE '\'`). */
export function escapeLikeNeedle(needle: string): string {
  return needle
    .replaceAll("\\", "\\\\")
    .replaceAll("%", String.raw`\%`)
    .replaceAll("_", String.raw`\_`)
}

/** Build a `%escaped%` LIKE pattern for a literal-substring match. */
function likePattern(needle: string): string {
  return `%${escapeLikeNeedle(needle)}%`
}

/** Center a snippet window on the first case-insensitive occurrence of `needle`. */
function makeSnippet(text: string, needle: string): string {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase())
  if (idx === -1) return text.slice(0, SNIPPET_RADIUS * 2)
  const start = Math.max(0, idx - SNIPPET_RADIUS)
  const end = Math.min(text.length, idx + needle.length + SNIPPET_RADIUS)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < text.length ? "…" : ""
  return `${prefix}${text.slice(start, end)}${suffix}`
}

interface StructuralWhere {
  sql: string
  params: Array<string | number>
}

/** Structural (non-text) filters on the joined entries_v2 row, aliased `e`. */
function structuralFilters(filters: QueryOptions | undefined): StructuralWhere {
  const where: Array<string> = []
  const params: Array<string | number> = []
  if (filters?.model) {
    where.push("e.model LIKE ?")
    params.push(`%${filters.model}%`)
  }
  if (filters?.endpoint) {
    where.push("e.endpoint = ?")
    params.push(filters.endpoint)
  }
  if (filters?.sessionId) {
    where.push("e.session_id = ?")
    params.push(filters.sessionId)
  }
  if (filters?.agentId) {
    where.push("e.agent_id = ?")
    params.push(filters.agentId)
  } else if (filters?.mainAgentOnly) {
    where.push("e.agent_id IS NULL")
  }
  if (filters?.from !== undefined) {
    where.push("e.started_at >= ?")
    params.push(filters.from)
  }
  if (filters?.to !== undefined) {
    where.push("e.started_at <= ?")
    params.push(filters.to)
  }
  if (filters?.state) {
    where.push("e.status = ?")
    params.push(filters.state)
  } else if (filters?.success === true) {
    where.push("e.status = ?")
    params.push("completed")
  } else if (filters?.success === false) {
    where.push("e.status = ?")
    params.push("failed")
  }
  if (filters?.pid !== undefined) {
    where.push("e.pid = ?")
    params.push(filters.pid)
  }
  return { sql: where.length > 0 ? `AND ${where.join(" AND ")}` : "", params }
}

/** Cursor encodes the last row's `(owner_started_at, ownerKey)` for keyset pagination. */
interface SearchCursor {
  startedAt: number
  key: string
}

function encodeCursor(startedAt: number, key: string): string {
  return `${startedAt}:${key}`
}

function decodeCursor(cursor: string | undefined): SearchCursor | undefined {
  if (!cursor) return undefined
  const sep = cursor.indexOf(":")
  if (sep === -1) return undefined
  const startedAt = Number(cursor.slice(0, sep))
  if (!Number.isFinite(startedAt)) return undefined
  return { startedAt, key: cursor.slice(sep + 1) }
}

interface InboundHitRow {
  hash: string
  text: string
  owner_req_id: string
  owner_started_at: number
}

/**
 * Search the content-addressed inbound messages. Returns one row per matching
 * message hash, owned by the earliest request referencing it.
 */
export function searchInbound(
  db: Database,
  needle: string,
  filters: QueryOptions | undefined,
  cursor: string | undefined,
  limit = DEFAULT_SEARCH_LIMIT,
): Array<SearchResultRow> {
  const struct = structuralFilters(filters)
  const page = decodeCursor(cursor)
  // owner = the (min started_at, then min id) request that references the hash and
  // passes the structural filters. GROUP BY hash collapses the "previous" copies.
  const keysetSql = page ? "HAVING owner_started_at < ? OR (owner_started_at = ? AND mb.hash > ?)" : ""
  const sql = `
    SELECT mb.hash AS hash,
           mb.text AS text,
           MIN(e.started_at) AS owner_started_at,
           (SELECT rm2.req_id FROM req_msg rm2 JOIN entries_v2 e2 ON e2.id = rm2.req_id
             WHERE rm2.hash = mb.hash ${struct.sql.replaceAll("e.", "e2.")}
             ORDER BY e2.started_at ASC, e2.id ASC LIMIT 1) AS owner_req_id
      FROM msg_blob mb
      JOIN req_msg rm ON rm.hash = mb.hash
      JOIN entries_v2 e ON e.id = rm.req_id
     WHERE mb.text LIKE ? ESCAPE '\\' ${struct.sql}
     GROUP BY mb.hash
     ${keysetSql}
     ORDER BY owner_started_at DESC, hash ASC
     LIMIT ?`
  const params: Array<string | number> = [...struct.params, likePattern(needle), ...struct.params]
  if (page) params.push(page.startedAt, page.startedAt, page.key)
  params.push(limit)
  const rows = db.prepare(sql).all(...params) as Array<InboundHitRow>

  const summaries = loadSummariesByIds(rows.map((r) => r.owner_req_id))
  return rows.flatMap((r) => {
    const summary = summaries.get(r.owner_req_id)
    if (!summary) return []
    return [{ source: "inbound" as const, hash: r.hash, ownerReqId: r.owner_req_id, snippet: makeSnippet(r.text, needle), summary }]
  })
}

interface AuxHitRow {
  req_id: string
  text: string
  started_at: number
}

/** Search one flat `req_aux` facet. Returns one row per matching request. */
export function searchAux(
  db: Database,
  source: Exclude<SearchSource, "inbound">,
  needle: string,
  filters: QueryOptions | undefined,
  cursor: string | undefined,
  limit = DEFAULT_SEARCH_LIMIT,
): Array<SearchResultRow> {
  const struct = structuralFilters(filters)
  const page = decodeCursor(cursor)
  const keysetSql = page ? "AND (e.started_at < ? OR (e.started_at = ? AND ra.req_id > ?))" : ""
  const sql = `
    SELECT ra.req_id AS req_id, ra.text AS text, e.started_at AS started_at
      FROM req_aux ra
      JOIN entries_v2 e ON e.id = ra.req_id
     WHERE ra.source = ? AND ra.text LIKE ? ESCAPE '\\' ${struct.sql} ${keysetSql}
     ORDER BY e.started_at DESC, ra.req_id ASC
     LIMIT ?`
  const params: Array<string | number> = [source, likePattern(needle), ...struct.params]
  if (page) params.push(page.startedAt, page.startedAt, page.key)
  params.push(limit)
  const rows = db.prepare(sql).all(...params) as Array<AuxHitRow>

  const summaries = loadSummariesByIds(rows.map((r) => r.req_id))
  return rows.flatMap((r) => {
    const summary = summaries.get(r.req_id)
    if (!summary) return []
    return [{ source, ownerReqId: r.req_id, snippet: makeSnippet(r.text, needle), summary }]
  })
}

/** Next-page cursor from the last result row (null when the page was not full). */
export function nextSearchCursor(rows: Array<SearchResultRow>, limit: number): string | null {
  if (rows.length < limit) return null
  const last = rows.at(-1)
  if (!last) return null
  const key = last.hash ?? last.ownerReqId
  return encodeCursor(last.summary.startedAt, key)
}

/** Lazy companion: every request id that references a given message hash (can be many). */
export function containingReqIds(db: Database, hash: string): Array<string> {
  const rows = db
    .prepare("SELECT rm.req_id AS req_id FROM req_msg rm JOIN entries_v2 e ON e.id = rm.req_id WHERE rm.hash = ? ORDER BY e.started_at DESC")
    .all(hash) as Array<{ req_id: string }>
  return rows.map((r) => r.req_id)
}
