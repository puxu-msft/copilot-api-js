import type { ModelOperationRecord } from "~/lib/context/model-operation-record"

import type {
  //
  EntrySummary,
  HistoryEntry,
  HistoryResult,
  QueryOptions,
  SummaryResult,
} from "./types"

import { formatFromEndpoint } from "./endpoint-format"
import {
  //
  resolveResponseModel,
  resolveResponseSuccess,
} from "./entry-view"
import {
  //
  getInFlight,
  listInFlight,
  toEntrySummary,
} from "./in-flight"
import {
  //
  isActiveState,
  lifecycleStatesForQuery,
  matchesLifecycleQuery,
} from "./lifecycle-state"
import { extractInboundSearchText } from "./normalize-message"
import { getHistorySearchClient } from "./search/client-registry"
import { HistorySearchUdsError } from "./search/uds-client"
import { getDatabase } from "./sqlite/connection"
import {
  //
  projectSearchableText,
  recordMatchesQuery,
  recordToEntrySummary,
  recordToHistoryEntry,
} from "./v3/projection"
import {
  //
  getV3StoredOperation,
  visitV3StoredOperations,
  visitV3Summaries,
} from "./v3/store"
import {
  //
  freezeHistorySearchTarget,
  getPersistedSummariesByIds,
  getPersistedSummary,
  hasPersistedSummaryMatching,
  isSummaryProjectionReady,
  querySummaryPage,
} from "./v3/summary-store"
import {
  //
  getRecentModelOperationDurability,
  getRecentModelOperationTerminal,
  listRecentModelOperationTerminals,
} from "./v3/terminal-bus"

function matchesFilters(entry: HistoryEntry, opts: QueryOptions): boolean {
  if (opts.sessionId && entry.sessionId !== opts.sessionId) return false
  if (opts.endpoint && entry.endpoint !== opts.endpoint) return false
  if (opts.from !== undefined && entry.startedAt < opts.from) return false
  if (opts.to !== undefined && entry.startedAt > opts.to) return false
  if (opts.model) {
    const needle = opts.model.toLowerCase()
    const req = entry.clientRequest?.model?.toLowerCase() ?? ""
    const res = resolveResponseModel(entry)?.toLowerCase() ?? ""
    if (!req.includes(needle) && !res.includes(needle)) return false
  }
  if (!matchesLifecycleQuery({ state: entry.state, responseSuccess: resolveResponseSuccess(entry) }, opts)) return false
  return true
}

/**
 * Whether a summary represents an active in-flight request (vs a terminal one).
 * `active` is the canonical flag the request lifecycle sets while streaming;
 * `state` is the belt-and-suspenders check for an eager-persisted `streaming`
 * SQLite head row (which reads back `active: false`). Used by `terminalOnly`.
 * The active/terminal partition is sourced from the single `lifecycle-state` primitive.
 */
function isInFlightSummary(summary: EntrySummary): boolean {
  return summary.active === true || (summary.state !== undefined && isActiveState(summary.state))
}

function compareSummaryNewestFirst(a: EntrySummary, b: EntrySummary): number {
  return b.startedAt - a.startedAt || b.id.localeCompare(a.id)
}

function recentRecordToSummary(record: NonNullable<ReturnType<typeof getRecentModelOperationTerminal>>): EntrySummary {
  const durability = getRecentModelOperationDurability(record.identity.operationId)
  return { ...recordToEntrySummary(record), ...(durability ? { durability } : {}) }
}

export class InvalidSummaryCursorError extends Error {
  constructor(cursor: string) {
    super(`Unknown or filtered summary cursor: ${cursor}`)
    this.name = "InvalidSummaryCursorError"
  }
}

/**
 * The caller's search string is not one the index can parse — a bad request, not a broken index.
 *
 * Kept apart from {@link HistorySearchUnavailableError} because they map to different statuses: the
 * search box is free text, and a query like `error:` or `-foo` used to travel as "sidecar
 * unavailable" and return 503 for the entire listing, in-flight rows included.
 */
export class InvalidSearchQueryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "InvalidSearchQueryError"
  }
}

export class HistorySearchUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "HistorySearchUnavailableError"
  }
}

function operationKindsForSearch(kind: NonNullable<QueryOptions["operationKind"]>): Array<string> {
  if (kind === "all") return []
  return kind === "generation" ? ["generation", "responses_ws"] : [kind]
}

function statesForSearch(options: QueryOptions): Array<string> {
  return [...(lifecycleStatesForQuery(options) ?? [])]
}

function hasConflictingLifecycleFilters(options: QueryOptions): boolean {
  return lifecycleStatesForQuery(options)?.length === 0
}

function emptySummaryResult(): SummaryResult {
  return { entries: [], total: 0, nextCursor: null, prevCursor: null }
}

function isOnCursorSide(summary: EntrySummary, cursor: EntrySummary | undefined, direction: "older" | "newer"): boolean {
  if (!cursor) return true
  const cmp = compareSummaryNewestFirst(summary, cursor)
  return direction === "newer" ? cmp < 0 : cmp > 0
}

function summaryMatchesFilters(summary: EntrySummary, opts: QueryOptions): boolean {
  if (opts.sessionId && summary.sessionId !== opts.sessionId) return false
  if (opts.endpoint && summary.endpoint !== opts.endpoint) return false
  if (opts.from !== undefined && summary.startedAt < opts.from) return false
  if (opts.to !== undefined && summary.startedAt > opts.to) return false
  if (opts.model) {
    const needle = opts.model.toLowerCase()
    const req = summary.requestModel?.toLowerCase() ?? ""
    const res = summary.responseModel?.toLowerCase() ?? ""
    if (!req.includes(needle) && !res.includes(needle)) return false
  }
  if (!matchesLifecycleQuery(summary, opts)) return false
  if (opts.agentId && summary.agentId !== opts.agentId) return false
  if (!opts.agentId && opts.mainAgentOnly && summary.agentId !== undefined) return false
  if (opts.pid !== undefined && summary.pid !== opts.pid) return false
  // NOTE: the `search` needle is intentionally NOT matched here — for in-flight
  // entries it is scanned against normalized inbound message text by
  // `inFlightMatchesSearch`. The ready persisted-summary path does not yet apply
  // full-text search; A3 routes that query through the independent Tantivy
  // list-search protocol rather than pretending preview_text is equivalent.
  return true
}

function summaryMatchesOperationKind(summary: EntrySummary, operationKind: NonNullable<QueryOptions["operationKind"]>): boolean {
  if (operationKind === "all") return true
  if (operationKind === "generation") {
    return summary.operationKind === undefined || summary.operationKind === "generation" || summary.operationKind === "responses_ws"
  }
  return summary.operationKind === operationKind
}

/**
 * Does a searchable corpus contain the needle? One definition, shared by every overlay path, so
 * that "matches the search" cannot mean two different things inside a single merged page. No needle
 * → always matches.
 *
 * Matching stays a lowercase substring test while the persisted index tokenizes. That residual
 * difference is deliberate: the overlay may over-match relative to the index, which surfaces a row
 * slightly early rather than hiding one, and it never produces the reverse.
 */
function corpusMatchesSearch(text: string, needle: string | undefined): boolean {
  if (!needle) return true
  return text.toLowerCase().includes(needle.toLowerCase())
}

/**
 * In-flight full-text search: a live entry has only its inbound messages, because nothing has been
 * committed yet, so that is its whole corpus.
 */
function inFlightMatchesSearch(entry: HistoryEntry, needle: string | undefined): boolean {
  const messages = entry.clientRequest?.messages ?? []
  const text = messages.length === 0 ? "" : extractInboundSearchText(messages, formatFromEndpoint(entry.endpoint))
  return corpusMatchesSearch(text, needle)
}

/**
 * A recent terminal record is matched against `projectSearchableText` — the SAME corpus the sidecar
 * is about to index — rather than against inbound text alone.
 *
 * Matching it more narrowly meant a word appearing only in the model's answer dropped the row for
 * the entire window between "terminal" and "indexed", after which the same row reappeared once the
 * sidecar caught up; a cursor pointing at such a row was also rejected with a 400 even though it is
 * perfectly valid under the persisted semantics.
 */
function recentMatchesSearch(record: ModelOperationRecord, needle: string | undefined): boolean {
  return corpusMatchesSearch(projectSearchableText(record), needle)
}

export function listHistoryOverlaySummaries(search?: string): Array<EntrySummary> {
  const merged = new Map<string, EntrySummary>()
  for (const entry of listInFlight()) {
    if (inFlightMatchesSearch(entry, search)) merged.set(entry.id, toEntrySummary(entry))
  }
  for (const record of listRecentModelOperationTerminals()) {
    const operationId = record.identity.operationId
    if (merged.has(operationId)) continue
    if (recentMatchesSearch(record, search)) merged.set(operationId, recentRecordToSummary(record))
  }
  return [...merged.values()]
}

export function listHistoryOverlayEntries(): Array<HistoryEntry> {
  const merged = new Map<string, HistoryEntry>()
  for (const entry of listInFlight()) merged.set(entry.id, entry)
  for (const record of listRecentModelOperationTerminals()) {
    const operationId = record.identity.operationId
    if (!merged.has(operationId)) merged.set(operationId, recordToHistoryEntry(record))
  }
  return [...merged.values()]
}

function persistedCandidates(
  options: QueryOptions,
  operationKind: NonNullable<QueryOptions["operationKind"]>,
  capacity: number,
): { rows: Array<NonNullable<ReturnType<typeof getV3StoredOperation>>>; total: number } {
  const rows: Array<NonNullable<ReturnType<typeof getV3StoredOperation>>> = []
  let total = 0
  const cursor = options.cursor ? getSummary(options.cursor) : undefined
  visitV3StoredOperations(
    (stored) => {
      if (!recordMatchesQuery(stored.record, { ...options, operationKind })) return
      total++
      const olderThanCursor =
        cursor === undefined
        || stored.record.identity.createdAt < cursor.startedAt
        || (stored.record.identity.createdAt === cursor.startedAt && stored.record.identity.operationId.localeCompare(cursor.id) < 0)
      if (olderThanCursor && rows.length < capacity) rows.push(stored)
    },
    operationKind === "all" || operationKind === "generation" ? undefined : operationKind,
  )
  return { rows, total }
}

function resolveSummaryCursor(
  options: QueryOptions,
  operationKind: NonNullable<QueryOptions["operationKind"]>,
  deferPersistedSearch = false,
): EntrySummary | undefined {
  const cursor = options.cursor
  if (!cursor) return undefined

  const inFlight = getInFlight(cursor)
  if (inFlight) {
    const summary = toEntrySummary(inFlight)
    if (summaryMatchesOperationKind(summary, operationKind) && summaryMatchesFilters(summary, options) && inFlightMatchesSearch(inFlight, options.search))
      return summary
    throw new InvalidSummaryCursorError(cursor)
  }

  const recent = getRecentModelOperationTerminal(cursor)
  if (recent) {
    // A row the index already holds is the index's to judge whenever the persisted search is
    // deferred to the sidecar. Applying the overlay's substring test to it rejects cursors the
    // sidecar counts as matches — a 400 on a page request that is valid under the only semantics
    // that will still apply once the overlay expires.
    const indexOwned = deferPersistedSearch && Boolean(options.search) && hasPersistedSummaryMatching(getDatabase(), cursor, { ...options, operationKind })
    if (recordMatchesQuery(recent, { ...options, operationKind }) && (indexOwned || recentMatchesSearch(recent, options.search)))
      return recentRecordToSummary(recent)
    throw new InvalidSummaryCursorError(cursor)
  }

  const db = getDatabase()
  const projectionReady = isSummaryProjectionReady(db)
  const persisted = projectionReady ? getPersistedSummary(db, cursor) : undefined
  if (
    persisted
    && summaryMatchesOperationKind(persisted, operationKind)
    && summaryMatchesFilters(persisted, options)
    && (deferPersistedSearch || !options.search)
  )
    return persisted
  if (!projectionReady) {
    const stored = getV3StoredOperation(cursor)
    if (stored && recordMatchesQuery(stored.record, { ...options, operationKind }) && !options.search) return recordToEntrySummary(stored.record, stored)
  }
  throw new InvalidSummaryCursorError(cursor)
}

function persistedSummaryCandidates(
  options: QueryOptions,
  operationKind: NonNullable<QueryOptions["operationKind"]>,
  capacity: number,
  cursor: EntrySummary | undefined,
): { rows: Array<EntrySummary>; total: number; nextCursor: string | null; prevCursor: string | null } {
  const db = getDatabase()
  if (isSummaryProjectionReady(db)) {
    const page = querySummaryPage(db, { ...options, operationKind }, capacity, cursor)
    return { rows: page.entries, total: page.total, nextCursor: page.nextCursor, prevCursor: page.prevCursor }
  }

  const all: Array<EntrySummary> = []
  visitV3Summaries(
    (summary) => {
      if (summaryMatchesOperationKind(summary, operationKind) && summaryMatchesFilters(summary, options)) all.push(summary)
    },
    operationKind === "all" || operationKind === "generation" ? undefined : operationKind,
  )
  all.sort(compareSummaryNewestFirst)
  const direction = options.direction ?? "older"
  const candidates = all.filter((summary) => isOnCursorSide(summary, cursor, direction))
  const rows = direction === "newer" ? candidates.slice(Math.max(0, candidates.length - capacity)) : candidates.slice(0, capacity)
  const newest = rows.at(0)
  const oldest = rows.at(-1)
  return {
    rows,
    total: all.length,
    nextCursor: oldest && all.some((summary) => compareSummaryNewestFirst(summary, oldest) > 0) ? oldest.id : null,
    prevCursor: newest && all.some((summary) => compareSummaryNewestFirst(summary, newest) < 0) ? newest.id : null,
  }
}

export function getEntry(id: string): HistoryEntry | undefined {
  const inflight = getInFlight(id)
  if (inflight) return inflight
  const recent = getRecentModelOperationTerminal(id)
  if (recent) return recordToHistoryEntry(recent)
  const stored = getV3StoredOperation(id)
  return stored ? recordToHistoryEntry(stored.record, stored) : undefined
}

export function getSummary(id: string): EntrySummary | undefined {
  const inflight = getInFlight(id)
  if (inflight) return toEntrySummary(inflight)
  const recent = getRecentModelOperationTerminal(id)
  if (recent) return recentRecordToSummary(recent)
  const db = getDatabase()
  if (isSummaryProjectionReady(db)) return getPersistedSummary(db, id)
  const stored = getV3StoredOperation(id)
  return stored ? recordToEntrySummary(stored.record, stored) : undefined
}

export function getHistory(options: QueryOptions = {}): HistoryResult {
  const { limit = 50 } = options
  if (hasConflictingLifecycleFilters(options)) {
    return { entries: [], total: 0, page: 1, limit, totalPages: 0 }
  }

  const inFlightMatches = listInFlight().filter((entry) => matchesFilters(entry, options) && inFlightMatchesSearch(entry, options.search))
  const operationKind = options.operationKind ?? "generation"
  const stored = persistedCandidates(options, operationKind, limit + 256 + inFlightMatches.length + 1)
  const persistedRecords = [...listRecentModelOperationTerminals().map((record) => ({ record, pinned: false })), ...stored.rows]
  const persisted = [...new Map(persistedRecords.map((stored) => [stored.record.identity.operationId, stored])).values()]
    .filter(({ record }) => recordMatchesQuery(record, { ...options, operationKind }))
    .map((stored) => recordToHistoryEntry(stored.record, stored))

  const seen = new Set<string>()
  const merged: Array<HistoryEntry> = []
  for (const entry of inFlightMatches) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id)
      merged.push(entry)
    }
  }
  for (const entry of persisted) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id)
      merged.push(entry)
    }
  }

  merged.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))

  const persistedIds = new Set(stored.rows.map(({ record }) => record.identity.operationId))
  const transientCount = merged.filter((entry) => !persistedIds.has(entry.id)).length
  const total = stored.total + transientCount
  const entries = merged.slice(0, limit)

  return {
    entries,
    total,
    page: 1,
    limit,
    totalPages: Math.ceil(total / limit),
  }
}

export async function getHistorySummariesAsync(options: QueryOptions = {}): Promise<SummaryResult> {
  if (hasConflictingLifecycleFilters(options)) return emptySummaryResult()
  if (!options.search) return getHistorySummaries(options)
  const { limit = 50, terminalOnly } = options
  const operationKind = options.operationKind ?? "generation"
  const direction = options.direction ?? "older"
  const inFlightSummaries = listInFlight()
    .filter((entry) => inFlightMatchesSearch(entry, options.search))
    .map((entry) => toEntrySummary(entry))
    .filter((summary) => summaryMatchesOperationKind(summary, operationKind) && summaryMatchesFilters(summary, options))
  const recentSummaries = listRecentModelOperationTerminals()
    .filter((record) => recordMatchesQuery(record, { ...options, operationKind }))
    .filter((record) => recentMatchesSearch(record, options.search))
    .map((record) => recentRecordToSummary(record))
  const cursorSummary = resolveSummaryCursor(options, operationKind, true)
  const db = getDatabase()
  if (!isSummaryProjectionReady(db)) {
    throw new HistorySearchUnavailableError("History summary projection is not ready for persisted full-text search")
  }
  const target = freezeHistorySearchTarget(db)
  /**
   * Ids the overlay must NOT contribute, resolved in the SAME pre-await snapshot as the sidecar
   * target: rows the index can already see are the index's to judge and to count.
   *
   * Two failures made this the criterion. Reading it AFTER the await let a row commit inside the
   * window and fall through both counters — too late for the frozen target, so `persistedTotal`
   * missed it, yet already persisted when classified, so `transientCount` skipped it as well.
   * And deciding by "is it persisted?" alone was still wrong even when frozen, because the two
   * sides do not agree on what matches: the overlay tests a lowercase substring while the index
   * tokenizes, so searching `orld` against a `hello world` document matches here and not there.
   * Such a row was shown while nothing counted it — the same `entries.length=1, total=0` shape,
   * now reachable without any race at all.
   *
   * Handing those rows to the sidecar outright removes the disagreement instead of trying to
   * reconcile it. The overlay keeps only what the index cannot see yet, which is the job it
   * exists for; and a row's membership stops changing as it crosses the persistence boundary.
   */
  const indexOwnedOverlayIds = new Set(
    [...inFlightSummaries, ...recentSummaries]
      .filter((summary) => hasPersistedSummaryMatching(db, summary.id, { ...options, operationKind }))
      .map((summary) => summary.id),
  )
  const overlaySummaries = [...inFlightSummaries, ...recentSummaries].filter((summary) => !indexOwnedOverlayIds.has(summary.id))
  let persistedRows: Array<EntrySummary> = []
  let persistedTotal = 0
  let persistedHasOlder = false
  let persistedHasNewer = false
  if (target) {
    const client = getHistorySearchClient()
    if (!client) throw new HistorySearchUnavailableError("History search sidecar client is unavailable")
    let response: Awaited<ReturnType<typeof client.listSearch>>
    try {
      response = await client.listSearch({
        query: options.search,
        filters: {
          operationKinds: operationKindsForSearch(operationKind),
          endpoint: options.endpoint,
          states: statesForSearch(options),
          pid: options.pid,
          sessionId: options.sessionId,
          agentId: options.agentId,
          mainAgentOnly: options.agentId ? undefined : options.mainAgentOnly,
          model: options.model,
          from: options.from,
          to: options.to,
        },
        cursor:
          cursorSummary ?
            {
              startedAt: cursorSummary.startedAt,
              operationId: cursorSummary.id,
              direction,
              // The sidecar must find the cursor unless the OVERLAY owns it. Asking the buses
              // directly would exempt a recent row the index already holds, and that row is exactly
              // the one whose match the sidecar has to decide.
              requireMatch: !overlaySummaries.some((summary) => summary.id === cursorSummary.id),
            }
          : undefined,
        limit: limit + overlaySummaries.length + 1,
        target,
      })
    } catch (error) {
      if (error instanceof InvalidSummaryCursorError) throw error
      if (error instanceof HistorySearchUdsError && error.code === "invalid-cursor") {
        throw new InvalidSummaryCursorError(options.cursor ?? "unknown")
      }
      if (error instanceof HistorySearchUdsError && error.code === "invalid-query") {
        throw new InvalidSearchQueryError(error.message, { cause: error })
      }
      throw new HistorySearchUnavailableError("History search sidecar could not serve the frozen target", { cause: error })
    }
    const boundaryCovered =
      response.attestation.committedAt !== null
      && (response.attestation.committedAt > target.committedAt
        || (response.attestation.committedAt === target.committedAt
          && target.operationIdsAtBoundary.every((operationId) => response.attestation.indexedAtBoundaryMs.includes(operationId))))
    if (!boundaryCovered) throw new HistorySearchUnavailableError("History search sidecar attestation does not cover the frozen target")
    if (response.attestation.poison.length > 0) {
      throw new HistorySearchUnavailableError(
        `History search sidecar skipped ${response.attestation.poison.length} operation(s) inside the frozen target: ${response.attestation.poison.map((entry) => entry.operationId).join(", ")}`,
      )
    }
    try {
      persistedRows = getPersistedSummariesByIds(db, response.operationIds)
    } catch (error) {
      throw new HistorySearchUnavailableError("History search sidecar returned a stale summary reference", { cause: error })
    }
    persistedTotal = response.total
    persistedHasOlder = response.hasOlder
    persistedHasNewer = response.hasNewer
  }

  const merged = new Map<string, EntrySummary>()
  for (const summary of [...overlaySummaries, ...persistedRows]) if (!merged.has(summary.id)) merged.set(summary.id, summary)
  const visible = terminalOnly ? [...merged.values()].filter((summary) => !isInFlightSummary(summary)) : [...merged.values()]
  const onPageSide = visible.filter((summary) => isOnCursorSide(summary, cursorSummary, direction)).sort(compareSummaryNewestFirst)
  const entries = direction === "newer" ? onPageSide.slice(Math.max(0, onPageSide.length - limit)) : onPageSide.slice(0, limit)
  // Every visible row is now counted exactly once, by exactly one side. `persistedRows` came from
  // the sidecar and are inside `persistedTotal`; everything else is an overlay row the index cannot
  // see yet, so nothing else counts it. (The synchronous sibling below keeps its live read — it has
  // no await, and no sidecar, so neither of the two failures above can arise there.)
  const persistedRowIds = new Set(persistedRows.map((summary) => summary.id))
  const transientCount = visible.filter((summary) => !persistedRowIds.has(summary.id)).length
  const total = persistedTotal + transientCount
  const newest = entries.at(0)
  const oldest = entries.at(-1)
  const hasNewerCandidate = newest ? visible.some((summary) => compareSummaryNewestFirst(summary, newest) < 0) : false
  const hasOlderCandidate = oldest ? visible.some((summary) => compareSummaryNewestFirst(summary, oldest) > 0) : false
  return {
    entries,
    total,
    nextCursor: oldest && (hasOlderCandidate || persistedHasOlder) ? oldest.id : null,
    prevCursor: newest && (hasNewerCandidate || persistedHasNewer) ? newest.id : null,
  }
}

export function getHistorySummaries(options: QueryOptions = {}): SummaryResult {
  if (hasConflictingLifecycleFilters(options)) return emptySummaryResult()
  const { limit = 50, terminalOnly } = options

  const operationKind = options.operationKind ?? "generation"
  const overlaySummaries = listHistoryOverlaySummaries(options.search).filter(
    (summary) => summaryMatchesOperationKind(summary, operationKind) && summaryMatchesFilters(summary, options),
  )
  const cursorSummary = resolveSummaryCursor(options, operationKind)
  const stored = persistedSummaryCandidates(options, operationKind, limit + 256 + overlaySummaries.length + 1, cursorSummary)

  const seen = new Set<string>()
  const merged: Array<EntrySummary> = []
  for (const summary of overlaySummaries) {
    if (!seen.has(summary.id)) {
      seen.add(summary.id)
      merged.push(summary)
    }
  }
  for (const summary of stored.rows) {
    if (!seen.has(summary.id)) {
      seen.add(summary.id)
      merged.push(summary)
    }
  }

  // terminalOnly: drop active in-flight rows so streaming requests stay out of
  // the History list (consumers like ui-v4 show them in a dedicated Live lane).
  // Source-agnostic by state — catches both the live in-flight map and any
  // eager-persisted `streaming` SQLite head row, and keeps terminal entries
  // regardless of which source they came from.
  const visible = terminalOnly ? merged.filter((summary) => !isInFlightSummary(summary)) : merged
  const direction = options.direction ?? "older"
  const onPageSide = visible.filter((summary) => isOnCursorSide(summary, cursorSummary, direction)).sort(compareSummaryNewestFirst)
  const entries = direction === "newer" ? onPageSide.slice(Math.max(0, onPageSide.length - limit)) : onPageSide.slice(0, limit)

  const db = getDatabase()
  const transientCount = visible.filter((summary) => !hasPersistedSummaryMatching(db, summary.id, { ...options, operationKind })).length
  const total = stored.total + transientCount
  const newest = entries.at(0)
  const oldest = entries.at(-1)
  const hasNewerCandidate = newest ? visible.some((summary) => compareSummaryNewestFirst(summary, newest) < 0) : false
  const hasOlderCandidate = oldest ? visible.some((summary) => compareSummaryNewestFirst(summary, oldest) > 0) : false
  let nextCursor: string | null = null
  if (oldest && (hasOlderCandidate || stored.nextCursor !== null)) nextCursor = oldest.id
  let prevCursor: string | null = null
  if (newest && (hasNewerCandidate || stored.prevCursor !== null)) prevCursor = newest.id

  return { entries, total, nextCursor, prevCursor }
}
