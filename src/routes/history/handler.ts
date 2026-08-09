import type { Context } from "hono"

import {
  //
  HistoryPinUnavailableError,
  exportHistory,
  getEntry,
  getHistorySummariesAsync,
  getSessionSummaries,
  getStats,
  isHistoryEnabled,
  searchContains,
  searchHistory,
  setPinned,
  type EndpointType,
  type QueryOptions,
  type SearchSource,
} from "~/lib/history"
import {
  //
  HistorySearchUnavailableError,
  InvalidSummaryCursorError,
} from "~/lib/history/queries"
import { compressAsync } from "~/lib/sqlite/compression"

/**
 * 从查询串解析 list 与 search 两处共享的结构化 filter 维（11 个）：
 * model / endpoint / success / state / from / to / search / sessionId / agentId /
 * mainAgentOnly / pid。
 *
 * 生产 History 删除面已退役，因此这里不再承担 scoped-delete 对齐契约。分页维
 * （cursor / limit / direction / terminalOnly）与 search 端点专有的 q / source 不在此列，
 * 由各 handler 自行叠加。
 */
function parseListFilters(query: Record<string, string>): QueryOptions {
  return {
    operationKind: (query.operationKind as QueryOptions["operationKind"]) || undefined,
    model: query.model || undefined,
    endpoint: query.endpoint as EndpointType | undefined,
    success: query.success ? query.success === "true" : undefined,
    state: (query.state as QueryOptions["state"]) || undefined,
    from: query.from ? Number.parseInt(query.from, 10) : undefined,
    to: query.to ? Number.parseInt(query.to, 10) : undefined,
    search: query.search || undefined,
    sessionId: query.sessionId || undefined,
    agentId: query.agentId || undefined,
    mainAgentOnly: query.mainAgentOnly === "true" ? true : undefined,
    pid: query.pid ? Number.parseInt(query.pid, 10) : undefined,
  }
}

function rejectsRetiredArchiveTier(c: Context): Response | undefined {
  if (c.req.query("tier") === "archive") return c.json({ error: "The built-in archive tier has been retired" }, 400)
  return undefined
}

const OPERATION_KINDS: ReadonlySet<string> = new Set(["generation", "count_tokens", "embeddings", "responses_ws", "all"])
const ENDPOINTS: ReadonlySet<string> = new Set(["anthropic-messages", "openai-chat-completions", "openai-responses", "gemini-generate-content"])
const LIFECYCLE_STATES: ReadonlySet<string> = new Set(["pending", "executing", "streaming", "completed", "failed", "aborted", "interrupted"])
const DIRECTIONS: ReadonlySet<string> = new Set(["older", "newer"])
const BOOLEANS: ReadonlySet<string> = new Set(["true", "false"])
const MAX_LIST_LIMIT = 1000

/**
 * Reject malformed `/api/entries` query parameters with a uniform 400 instead of letting them reach
 * the read path, where an unknown enum silently matched nothing and a non-finite `limit` or `pid`
 * became a 500 or an unbounded scan.
 *
 * Scope is this endpoint only (user ruling 2026-08-08): `/api/search` keeps its lenient contract of
 * degrading unsupported facets to an empty 200. Empty values stay ignored — `?model=` is "no filter",
 * not a malformed request — so the pre-existing empty-string behaviour is unchanged.
 */
function rejectsInvalidListQuery(c: Context): Response | undefined {
  const query = c.req.query()
  const invalid = (name: string, value: string, expectation: string): Response => c.json({ error: `Invalid ${name} '${value}'. ${expectation}` }, 400)

  for (const [name, allowed] of [
    ["operationKind", OPERATION_KINDS],
    ["endpoint", ENDPOINTS],
    ["state", LIFECYCLE_STATES],
    ["direction", DIRECTIONS],
    ["success", BOOLEANS],
    ["mainAgentOnly", BOOLEANS],
    ["terminalOnly", BOOLEANS],
  ] as const) {
    const value = query[name]
    if (value && !allowed.has(value)) return invalid(name, value, `Expected one of: ${[...allowed].join(", ")}`)
  }

  for (const name of ["from", "to", "pid", "limit"] as const) {
    const raw = query[name]
    if (!raw) continue
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 0) return invalid(name, raw, "Expected a non-negative safe integer.")
    if (name === "limit" && (value === 0 || value > MAX_LIST_LIMIT)) return invalid(name, raw, `Expected an integer between 1 and ${MAX_LIST_LIMIT}.`)
  }

  const from = query.from ? Number(query.from) : undefined
  const to = query.to ? Number(query.to) : undefined
  if (from !== undefined && to !== undefined && from > to) {
    return c.json({ error: `Invalid range: from ${from} is later than to ${to}.` }, 400)
  }
  return undefined
}

export async function handleGetEntries(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }
  const retiredTier = rejectsRetiredArchiveTier(c)
  if (retiredTier) return retiredTier
  const invalidQuery = rejectsInvalidListQuery(c)
  if (invalidQuery) return invalidQuery

  const query = c.req.query()
  const options: QueryOptions = {
    ...parseListFilters(query),
    // 分页维单独解析并叠加：故意不并入共享 filter，避免空列表分页请求被误判为「有筛选」。
    cursor: query.cursor || undefined,
    limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
    direction: query.direction ? (query.direction as "older" | "newer") : undefined,
    terminalOnly: query.terminalOnly === "true" ? true : undefined,
  }

  try {
    return c.json(await getHistorySummariesAsync(options))
  } catch (error) {
    if (error instanceof InvalidSummaryCursorError) return c.json({ error: error.message }, 400)
    if (error instanceof HistorySearchUnavailableError) return c.json({ error: error.message }, 503)
    throw error
  }
}

/**
 * GET /history/api/sessions — per-session aggregate view (grouped by session_id over
 * terminal V3 operation records). `?limit=N` caps the number of sessions returned
 * (defaults to the store's internal cap when absent). Returns `{ sessions: [...] }`.
 */
export function handleGetSessions(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const limitRaw = c.req.query("limit")
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
  return c.json({ sessions: getSessionSummaries(limit) })
}

export function handleGetEntry(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }
  const retiredTier = rejectsRetiredArchiveTier(c)
  if (retiredTier) return retiredTier

  const id = c.req.param("id")
  if (!id) {
    return c.json({ error: "Entry id is required" }, 400)
  }
  const entry = getEntry(id)

  if (!entry) {
    return c.json({ error: "Entry not found" }, 404)
  }

  return c.json(entry)
}

/**
 * GET /history/api/entries/:id/export — download one entry as a zstd-compressed
 * `.json.zst` file. Reads the canonical richest form via `getEntry` (in-flight
 * map ?? `assembleFullEntry` — all stages, per-attempt sseEvents, every header
 * leg, request_group expanded), so the export is authoritative and complete
 * server-side rather than depending on what the UI happens to have loaded. Reuses
 * the storage-path `compressAsync` (zstd L3, off the event loop). Guards mirror
 * `handleGetEntry`: 400 if history disabled, 400 if id missing, 404 if unknown.
 */
export async function handleExportEntry(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const id = c.req.param("id")
  if (!id) {
    return c.json({ error: "Entry id is required" }, 400)
  }
  const entry = getEntry(id)
  if (!entry) {
    return c.json({ error: "Entry not found" }, 404)
  }

  const blob = await compressAsync(entry)
  const model = entry.attempts?.at(-1)?.upstreamResponse?.model || entry.clientRequest?.model || "unknown"
  // Model is raw client input; keep only filename-safe chars so `/`, `:`, spaces, or a
  // CRLF-bearing model can't break the Content-Disposition header (which would 500 the export).
  const safeModel = model.replaceAll(/[^\w.-]/g, "_")
  return new Response(blob, {
    headers: {
      "Content-Type": "application/zstd",
      "Content-Disposition": `attachment; filename="${id}_${safeModel}.json.zst"`,
    },
  })
}

/**
 * POST /history/api/entries/:id/pin and .../unpin — toggle the debug-pin flag.
 *
 * A pinned entry is exempt from the AUTOMATIC reaper (never evicted, not counted
 * toward the retention limits), keeping its raw request/response data across GC
 * while debugging. It is NOT immortal: explicit `DELETE /api/sessions/:id` and
 * `DELETE /api/entries` (clear-all) still remove it — pin only blocks the
 * background reaper, not deliberate deletion. Returns the refreshed full entry
 * (richest form, so the caller sees `pinned` plus everything else without a
 * second round-trip). 404 if unknown.
 */
function setEntryPinState(c: Context, pinned: boolean) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }
  const id = c.req.param("id")
  if (!id) {
    return c.json({ error: "Entry id is required" }, 400)
  }
  // Pinning has no writer between the Batch 2b cutover and the Batch 6 set-pinned RPC (user ruling, 2026-08-09). Answer 503 with the reason rather than letting the missing write handle surface as a 500 that reads like a database fault.
  try {
    if (!setPinned(id, pinned)) {
      return c.json({ error: "Entry not found" }, 404)
    }
  } catch (err: unknown) {
    if (err instanceof HistoryPinUnavailableError) {
      return c.json({ error: err.message }, 503)
    }
    throw err
  }
  const entry = getEntry(id)
  if (!entry) {
    return c.json({ error: "Entry not found" }, 404)
  }
  return c.json(entry)
}

export function handlePinEntry(c: Context) {
  return setEntryPinState(c, true)
}

export function handleUnpinEntry(c: Context) {
  return setEntryPinState(c, false)
}

export function handleGetStats(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const stats = getStats()
  return c.json(stats)
}

export function handleExport(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }

  const format = (c.req.query("format") || "json") as "json" | "csv"
  const data = exportHistory(format)

  if (format === "csv") {
    c.header("Content-Type", "text/csv")
    c.header("Content-Disposition", "attachment; filename=history.csv")
  } else {
    c.header("Content-Type", "application/json")
    c.header("Content-Disposition", "attachment; filename=history.json")
  }

  return c.body(data)
}

const SEARCH_SOURCES: ReadonlySet<SearchSource> = new Set<SearchSource>(["inbound", "rewrites-req", "rewrites-resp", "req-headers", "resp-headers"])

/**
 * GET /history/api/search — full-text search, forwarded to the independent
 * history-search sidecar SERVICE over UDS (history-search-out-of-process plan
 * Phase 4). Only `source=inbound` is served (the sidecar's Tantivy projection
 * indexes just the client-facing conversation + response); every other facet
 * value, and an absent/unreachable sidecar, both degrade to an empty result
 * with `partial: true` (see `search.ts`'s module doc) — 200, never 500, and
 * never a silent fallback to History SQLite.
 */
export async function handleSearch(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }
  const retiredTier = rejectsRetiredArchiveTier(c)
  if (retiredTier) return retiredTier

  const query = c.req.query()
  const source = (query.source || "inbound") as SearchSource
  if (!SEARCH_SOURCES.has(source)) {
    return c.json({ error: `Invalid source '${source}'. Expected one of: ${[...SEARCH_SOURCES].join(", ")}` }, 400)
  }

  // search 端点用 q + source 做全文检索；历史上不把结构化的 search 子串维并入 filter
  // （structuralFilters 也不消费它），保持这一对外行为——从共享解析结果里剔除 search，
  // 其余 10 个结构化维与 list / delete 完全一致，享受单一事实源、免于将来的解析漂移。
  const { search: _search, ...filters } = parseListFilters(query)

  try {
    const result = await searchHistory({
      source,
      q: query.q || "",
      limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
      cursor: query.cursor || undefined,
      filters,
    })
    return c.json(result)
  } catch (error) {
    // `searchHistory` itself never throws (the sidecar client's never-throw
    // contract, forwarded verbatim) — this catch is defense-in-depth against an
    // unexpected failure in the History-facade lookups it also does (e.g.
    // `getSummary`), not the sidecar path itself.
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 501)
  }
}

/**
 * GET /history/api/search/contains?hash= — compatibility surface. Embedded
 * object membership was removed with the SQLite search projection.
 */
export function handleSearchContains(c: Context) {
  if (!isHistoryEnabled()) {
    return c.json({ error: "History recording is not enabled" }, 400)
  }
  const hash = c.req.query("hash")
  if (!hash) {
    return c.json({ error: "hash query parameter is required" }, 400)
  }
  try {
    return c.json({ hash, reqIds: searchContains(hash) })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 501)
  }
}
