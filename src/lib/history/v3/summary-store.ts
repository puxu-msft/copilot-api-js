import type {
  //
  EntrySummary,
  HistoryStats,
  QueryOptions,
  SessionSummary,
  SummaryResult,
} from "~/lib/history/core-types"
import type { HistorySearchFreshnessTarget } from "~/lib/history/search/protocol"
import type { Database } from "~/lib/history/sqlite/connection"

import {
  //
  getMeta,
  setMeta,
} from "~/lib/history/sqlite/meta"

import {
  //
  historicalProjectionValues,
  projectionColumns,
  projectionEquality,
  SUMMARY_PROJECTION_READY_KEY,
  validatedReadyAssignments,
} from "./summary-schema"

export { SUMMARY_PROJECTION_READY_KEY } from "./summary-schema"

interface SummaryWhere {
  sql: string
  params: Array<unknown>
}

const LIKE_ESCAPE = String.fromCodePoint(92)

function escapeLike(value: string): string {
  return value.replaceAll(LIKE_ESCAPE, LIKE_ESCAPE.repeat(2)).replaceAll("%", `${LIKE_ESCAPE}%`).replaceAll("_", `${LIKE_ESCAPE}_`)
}

function compileSummaryWhere(options: QueryOptions): SummaryWhere {
  const terms = ["projection_status='ready'"]
  const params: Array<unknown> = []
  const kind = options.operationKind ?? "generation"
  if (kind === "generation") {
    terms.push("operation_kind IN ('generation','responses_ws')")
  } else if (kind !== "all") {
    terms.push("operation_kind=?")
    params.push(kind)
  }
  if (options.model) {
    terms.push(`(lower(request_model) LIKE ? ESCAPE '${LIKE_ESCAPE}' OR lower(response_model) LIKE ? ESCAPE '${LIKE_ESCAPE}')`)
    const needle = `%${escapeLike(options.model.toLowerCase())}%`
    params.push(needle, needle)
  }
  if (options.endpoint) {
    terms.push("endpoint=?")
    params.push(options.endpoint)
  }
  if (options.state) {
    terms.push("state=?")
    params.push(options.state)
  } else if (options.success !== undefined) {
    terms.push(options.success ? "state='completed'" : "state='failed'")
  }
  if (options.from !== undefined) {
    terms.push("started_at>=?")
    params.push(options.from)
  }
  if (options.to !== undefined) {
    terms.push("started_at<=?")
    params.push(options.to)
  }
  if (options.sessionId) {
    terms.push("session_id=?")
    params.push(options.sessionId)
  }
  if (options.agentId) {
    terms.push("agent_id=?")
    params.push(options.agentId)
  } else if (options.mainAgentOnly) {
    terms.push("agent_id IS NULL")
  }
  if (options.pid !== undefined) {
    terms.push("pid=?")
    params.push(options.pid)
  }
  return { sql: terms.join(" AND "), params }
}

function parseSummaryJson(row: { summary_json: string; pinned: number }): EntrySummary {
  return { ...(JSON.parse(row.summary_json) as EntrySummary), active: false, pinned: row.pinned === 1 }
}

export function getPersistedSummary(db: Database, operationId: string): EntrySummary | undefined {
  const row = db.prepare("SELECT summary_json,pinned FROM v3_operation_summaries WHERE operation_id=? AND projection_status='ready'").get(operationId) as
    | { summary_json: string; pinned: number }
    | undefined
  return row ? parseSummaryJson(row) : undefined
}

export function freezeHistorySearchTarget(db: Database): HistorySearchFreshnessTarget | null {
  const boundary = db.prepare("SELECT MAX(committed_at) AS committed_at FROM v3_operations").get() as { committed_at: number | null }
  if (boundary.committed_at === null) return null
  const operationIdsAtBoundary = (
    db.prepare("SELECT operation_id FROM v3_operations WHERE committed_at=? ORDER BY operation_id").all(boundary.committed_at) as Array<{
      operation_id: string
    }>
  ).map((row) => row.operation_id)
  return { committedAt: boundary.committed_at, operationIdsAtBoundary }
}

export function getPersistedSummariesByIds(db: Database, operationIds: ReadonlyArray<string>): Array<EntrySummary> {
  if (operationIds.length === 0) return []
  const rows = db
    .prepare(
      `SELECT operation_id,summary_json,pinned
       FROM v3_operation_summaries
       WHERE projection_status='ready'
         AND operation_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(operationIds)) as Array<{ operation_id: string; summary_json: string; pinned: number }>
  const byId = new Map(rows.map((row) => [row.operation_id, parseSummaryJson(row)]))
  return operationIds.map((operationId) => {
    const summary = byId.get(operationId)
    if (!summary) throw new Error(`History search references a missing or non-ready summary: ${operationId}`)
    return summary
  })
}

export function hasPersistedSummaryMatching(db: Database, operationId: string, options: QueryOptions): boolean {
  const where = compileSummaryWhere(options)
  return Boolean(db.prepare(`SELECT 1 FROM v3_operation_summaries WHERE operation_id=? AND ${where.sql} LIMIT 1`).get(operationId, ...where.params))
}

function summaryPageIndex(options: QueryOptions): string {
  const kind = options.operationKind ?? "generation"
  return kind === "all" || kind === "generation" ? "idx_v3_operation_summaries_created" : "idx_v3_operation_summaries_kind_created"
}

function summaryPageSql(options: QueryOptions, where: SummaryWhere, boundary: string, order: string, explain = false): string {
  const prefix = explain ? "EXPLAIN QUERY PLAN " : ""
  return `${prefix}SELECT summary_json,pinned FROM v3_operation_summaries INDEXED BY ${summaryPageIndex(options)} WHERE ${where.sql}${boundary} ORDER BY ${order} LIMIT ?`
}

export function explainSummaryPagePlan(db: Database, options: QueryOptions, limit: number): Array<string> {
  const where = compileSummaryWhere(options)
  const order = options.direction === "newer" ? "started_at ASC,operation_id ASC" : "started_at DESC,operation_id DESC"
  return (db.prepare(summaryPageSql(options, where, "", order, true)).all(...where.params, limit) as Array<{ detail: string }>).map((row) => row.detail)
}

export function querySummaryPage(db: Database, options: QueryOptions, limit: number, cursorSummary?: EntrySummary): SummaryResult {
  const where = compileSummaryWhere(options)
  const cursor = cursorSummary ?? (options.cursor ? getPersistedSummary(db, options.cursor) : undefined)
  if (options.cursor && !cursor) throw new Error(`Unknown summary cursor: ${options.cursor}`)
  const direction = options.direction ?? "older"
  let boundary = ""
  if (cursor) {
    boundary = direction === "newer" ? " AND (started_at>? OR (started_at=? AND operation_id>?))" : " AND (started_at<? OR (started_at=? AND operation_id<?))"
  }
  const boundaryParams = cursor ? [cursor.startedAt, cursor.startedAt, cursor.id] : []
  const order = direction === "newer" ? "started_at ASC,operation_id ASC" : "started_at DESC,operation_id DESC"
  const rows = db.prepare(summaryPageSql(options, where, boundary, order)).all(...where.params, ...boundaryParams, Math.max(0, limit)) as Array<{
    summary_json: string
    pinned: number
  }>
  const entries = rows.map((row) => parseSummaryJson(row))
  if (direction === "newer") entries.reverse()
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM v3_operation_summaries WHERE ${where.sql}`).get(...where.params) as { n: number }).n

  const newest = entries.at(0)
  const oldest = entries.at(-1)
  let hasNewer = false
  if (newest) {
    hasNewer = Boolean(
      db
        .prepare(`SELECT 1 FROM v3_operation_summaries WHERE ${where.sql} AND (started_at>? OR (started_at=? AND operation_id>?)) LIMIT 1`)
        .get(...where.params, newest.startedAt, newest.startedAt, newest.id),
    )
  }
  let hasOlder = false
  if (oldest) {
    hasOlder = Boolean(
      db
        .prepare(`SELECT 1 FROM v3_operation_summaries WHERE ${where.sql} AND (started_at<? OR (started_at=? AND operation_id<?)) LIMIT 1`)
        .get(...where.params, oldest.startedAt, oldest.startedAt, oldest.id),
    )
  }
  let nextCursor: string | null = null
  if (hasOlder && oldest) nextCursor = oldest.id
  let prevCursor: string | null = null
  if (hasNewer && newest) prevCursor = newest.id
  return { entries, total, nextCursor, prevCursor }
}

export interface PersistedSessionEntryPage {
  operationIds: Array<string>
  total: number
  nextCursor: string | null
  prevCursor: string | null
}

function sessionEntryPageSql(boundary: string, explain = false): string {
  const prefix = explain ? "EXPLAIN QUERY PLAN " : ""
  return `${prefix}SELECT operation_id
    FROM v3_operation_summaries INDEXED BY idx_v3_operation_summaries_session
    WHERE session_id=? AND operation_kind='generation' AND projection_status='ready'${boundary}
    ORDER BY started_at,operation_id
    LIMIT ?`
}

export function explainSessionEntryPagePlan(db: Database, sessionId: string, limit: number): Array<string> {
  return (db.prepare(sessionEntryPageSql("", true)).all(sessionId, limit) as Array<{ detail: string }>).map((row) => row.detail)
}

export function querySessionEntryPage(db: Database, sessionId: string, cursor: string | undefined, limit: number): PersistedSessionEntryPage {
  const cursorRow =
    cursor ?
      (db
        .prepare(
          `SELECT started_at,operation_id
           FROM v3_operation_summaries
           WHERE operation_id=? AND session_id=? AND operation_kind='generation' AND projection_status='ready'`,
        )
        .get(cursor, sessionId) as { started_at: number; operation_id: string } | undefined)
    : undefined
  const boundary = cursorRow ? " AND (started_at>? OR (started_at=? AND operation_id>?))" : ""
  const boundaryParams = cursorRow ? [cursorRow.started_at, cursorRow.started_at, cursorRow.operation_id] : []
  const boundedLimit = Math.max(0, limit)
  const rows = db.prepare(sessionEntryPageSql(boundary)).all(sessionId, ...boundaryParams, boundedLimit + 1) as Array<{ operation_id: string }>
  const hasMore = rows.length > boundedLimit
  const operationIds = rows.slice(0, boundedLimit).map((row) => row.operation_id)
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM v3_operation_summaries
         WHERE session_id=? AND operation_kind='generation' AND projection_status='ready'`,
      )
      .get(sessionId) as { n: number }
  ).n
  return {
    operationIds,
    total,
    nextCursor: hasMore ? (operationIds.at(-1) ?? null) : null,
    prevCursor: cursorRow && operationIds.length > 0 ? operationIds[0] : null,
  }
}

interface PersistedSessionAggregate {
  session_id: string
  request_count: number
  agent_count: number
  input_tokens: number
  output_tokens: number
  first_started_at: number
  last_started_at: number
  completed: number
  failed: number
  aborted: number
  models_json: string
  first_preview: string | null
  preview: string | null
}

export function querySessionSummaries(db: Database, limit: number): Array<SessionSummary> {
  const rows = db
    .prepare(
      `WITH generation_rows AS (
         SELECT *
         FROM v3_operation_summaries
         WHERE projection_status='ready'
           AND operation_kind='generation'
           AND session_id IS NOT NULL
       ),
       grouped AS (
         SELECT
           session_id,
           COUNT(*) AS request_count,
           COUNT(DISTINCT agent_id) AS agent_count,
           SUM(COALESCE(input_tokens,0) + COALESCE(cache_read_input_tokens,0) + COALESCE(cache_creation_input_tokens,0)) AS input_tokens,
           SUM(COALESCE(output_tokens,0)) AS output_tokens,
           MIN(started_at) AS first_started_at,
           MAX(started_at) AS last_started_at,
           SUM(CASE WHEN state='completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN state IN ('aborted','interrupted') THEN 1 ELSE 0 END) AS aborted
         FROM generation_rows
         GROUP BY session_id
         ORDER BY last_started_at DESC,session_id DESC
         LIMIT ?
       ),
       model_occurrences AS (
         SELECT
           session_id,
           COALESCE(response_model,request_model) AS model,
           started_at,
           operation_id,
           ROW_NUMBER() OVER (
             PARTITION BY session_id,COALESCE(response_model,request_model)
             ORDER BY started_at,operation_id
           ) AS occurrence
         FROM generation_rows
         WHERE COALESCE(response_model,request_model) IS NOT NULL
       ),
       session_models AS (
         SELECT
           session_id,
           json_group_array(model ORDER BY started_at,operation_id) AS models_json
         FROM model_occurrences
         WHERE occurrence=1
         GROUP BY session_id
       )
       SELECT
         grouped.*,
         COALESCE(session_models.models_json, '[]') AS models_json,
         first_row.preview_text AS first_preview,
         last_row.preview_text AS preview
       FROM grouped
       LEFT JOIN session_models ON session_models.session_id=grouped.session_id
       JOIN generation_rows first_row ON first_row.operation_id=(
         SELECT operation_id FROM generation_rows
         WHERE session_id=grouped.session_id
         ORDER BY started_at,operation_id
         LIMIT 1
       )
       JOIN generation_rows last_row ON last_row.operation_id=(
         SELECT operation_id FROM generation_rows
         WHERE session_id=grouped.session_id
         ORDER BY started_at DESC,operation_id DESC
         LIMIT 1
       )
       ORDER BY grouped.last_started_at DESC,grouped.session_id DESC`,
    )
    .all(Math.max(0, limit)) as Array<PersistedSessionAggregate>

  return rows.map((row) => ({
    sessionId: row.session_id,
    requestCount: row.request_count,
    agentCount: row.agent_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    firstStartedAt: row.first_started_at,
    lastStartedAt: row.last_started_at,
    completed: row.completed,
    failed: row.failed,
    aborted: row.aborted,
    models: JSON.parse(row.models_json) as Array<string>,
    firstPreview: row.first_preview ?? "",
    preview: row.preview ?? "",
  }))
}

interface PersistedStatsAggregate {
  total_requests: number
  successful_requests: number | null
  failed_requests: number | null
  aborted_requests: number | null
  interrupted_requests: number | null
  total_input_tokens: number | null
  total_output_tokens: number | null
  total_duration_ms: number | null
}

function statsExclusion(overlayIds: ReadonlyArray<string>): { sql: string; param: string } {
  return {
    sql: overlayIds.length === 0 ? "" : " AND operation_id NOT IN (SELECT value FROM json_each(?))",
    param: JSON.stringify(overlayIds),
  }
}

export function queryPersistedStats(
  db: Database,
  overlayIds: ReadonlyArray<string>,
): { stats: HistoryStats; totalDurationMs: number; sessionIds: Array<string> } {
  const exclusion = statsExclusion(overlayIds)
  const baseWhere = `projection_status='ready'${exclusion.sql}`
  const params = overlayIds.length === 0 ? [] : [exclusion.param]
  const aggregate = db
    .prepare(
      `SELECT
         COUNT(*) AS total_requests,
         SUM(CASE
           WHEN state='completed' THEN 1
           WHEN state NOT IN ('completed','failed','aborted','interrupted') AND response_success=1 THEN 1
           WHEN state IS NULL AND response_success=1 THEN 1
           ELSE 0
         END) AS successful_requests,
         SUM(CASE
           WHEN state='failed' THEN 1
           WHEN state NOT IN ('completed','failed','aborted','interrupted') AND response_success=0 THEN 1
           WHEN state IS NULL AND response_success=0 THEN 1
           ELSE 0
         END) AS failed_requests,
         SUM(CASE WHEN state='aborted' THEN 1 ELSE 0 END) AS aborted_requests,
         SUM(CASE WHEN state='interrupted' THEN 1 ELSE 0 END) AS interrupted_requests,
         SUM(COALESCE(input_tokens,0)) AS total_input_tokens,
         SUM(COALESCE(output_tokens,0)) AS total_output_tokens,
         SUM(COALESCE(duration_ms,0)) AS total_duration_ms
       FROM v3_operation_summaries
       WHERE ${baseWhere}`,
    )
    .get(...params) as PersistedStatsAggregate
  const modelRows = db
    .prepare(
      `SELECT COALESCE(response_model,request_model) AS key,COUNT(*) AS count
       FROM v3_operation_summaries
       WHERE ${baseWhere} AND COALESCE(response_model,request_model) IS NOT NULL
       GROUP BY key`,
    )
    .all(...params) as Array<{ key: string; count: number }>
  const endpointRows = db
    .prepare(
      `SELECT endpoint AS key,COUNT(*) AS count
       FROM v3_operation_summaries
       WHERE ${baseWhere}
       GROUP BY endpoint`,
    )
    .all(...params) as Array<{ key: string; count: number }>
  const sessionRows = db
    .prepare(
      `SELECT DISTINCT session_id
       FROM v3_operation_summaries
       WHERE ${baseWhere} AND session_id IS NOT NULL`,
    )
    .all(...params) as Array<{ session_id: string }>
  const totalRequests = aggregate.total_requests
  const totalDurationMs = aggregate.total_duration_ms ?? 0
  return {
    stats: {
      totalRequests,
      successfulRequests: aggregate.successful_requests ?? 0,
      failedRequests: aggregate.failed_requests ?? 0,
      abortedRequests: aggregate.aborted_requests ?? 0,
      interruptedRequests: aggregate.interrupted_requests ?? 0,
      totalInputTokens: aggregate.total_input_tokens ?? 0,
      totalOutputTokens: aggregate.total_output_tokens ?? 0,
      averageDurationMs: totalRequests === 0 ? 0 : totalDurationMs / totalRequests,
      modelDistribution: Object.fromEntries(modelRows.map((row) => [row.key, row.count])),
      endpointDistribution: Object.fromEntries(endpointRows.map((row) => [row.key, row.count])),
      recentActivity: [],
      activeSessions: sessionRows.length,
    },
    totalDurationMs,
    sessionIds: sessionRows.map((row) => row.session_id),
  }
}

export interface SummaryProjectionReadiness {
  ready: boolean
  pending: number
  poisoned: number
}

export type ValidatedSummarySnapshot<T> = { ready: false } | { ready: true; value: T }

let summarySnapshotObserverForTests: (() => void) | undefined

export function setSummarySnapshotObserverForTests(observer: (() => void) | undefined): void {
  summarySnapshotObserverForTests = observer
}

export function withValidatedSummarySnapshot<T>(db: Database, read: () => T): ValidatedSummarySnapshot<T> {
  const transaction = db.transaction<ValidatedSummarySnapshot<T>>(() => {
    if (!isSummaryProjectionReady(db)) return { ready: false }
    summarySnapshotObserverForTests?.()
    return { ready: true, value: read() }
  })
  return transaction()
}

export function isSummaryProjectionReady(db: Database): boolean {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('history_meta','v3_operation_summaries')").all() as Array<{
    name: string
  }>
  if (tables.length !== 2) return false
  return getMeta(db, SUMMARY_PROJECTION_READY_KEY) === "1"
}

export function getSummaryProjectionReadiness(db: Database): SummaryProjectionReadiness {
  const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='v3_operation_summaries'").get()
  if (!table) return { ready: false, pending: 0, poisoned: 0 }
  const statuses = db
    .prepare(
      `SELECT
         SUM(CASE WHEN projection_status='pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN projection_status='poisoned' THEN 1 ELSE 0 END) AS poisoned
       FROM v3_operation_summaries`,
    )
    .get() as { pending: number | null; poisoned: number | null }
  return {
    ready: getMeta(db, SUMMARY_PROJECTION_READY_KEY) === "1",
    pending: statuses.pending ?? 0,
    poisoned: statuses.poisoned ?? 0,
  }
}

export interface SummaryBackfillCursor {
  createdAt: number
  operationId: string
}

export interface SummaryBackfillPage {
  inserted: number
  cursor: SummaryBackfillCursor | null
}

function summaryBackfillPageSql(cursor: SummaryBackfillCursor | null | undefined, explain = false): string {
  const prefix = explain ? "EXPLAIN QUERY PLAN " : ""
  const boundary = cursor ? " AND (created_at,operation_id)>(?,?)" : ""
  return `${prefix}SELECT created_at,operation_id
    FROM v3_operations INDEXED BY idx_v3_operations_created
    WHERE NOT EXISTS (
      SELECT 1 FROM v3_operation_summaries
      WHERE v3_operation_summaries.operation_id=v3_operations.operation_id
    )${boundary}
    ORDER BY created_at,operation_id
    LIMIT ?`
}

export function explainSummaryBackfillPlan(db: Database, cursor?: SummaryBackfillCursor | null, limit = 16): Array<string> {
  const params = cursor ? [cursor.createdAt, cursor.operationId, limit] : [limit]
  return (db.prepare(summaryBackfillPageSql(cursor, true)).all(...params) as Array<{ detail: string }>).map((row) => row.detail)
}

export function backfillExistingSummaryRows(db: Database, limit: number, cursor?: SummaryBackfillCursor | null): SummaryBackfillPage {
  const params = cursor ? [cursor.createdAt, cursor.operationId, limit] : [limit]
  const rows = db.prepare(summaryBackfillPageSql(cursor)).all(...params) as Array<{ created_at: number; operation_id: string }>
  if (rows.length === 0) return { inserted: 0, cursor: null }

  const operationIds = rows.map((row) => row.operation_id)
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO v3_operation_summaries(${projectionColumns})
       SELECT ${historicalProjectionValues}
       FROM v3_operations
       WHERE operation_id IN (SELECT value FROM json_each(?))`,
    )
    .run(JSON.stringify(operationIds))
  const last = rows.at(-1)
  if (!last) return { inserted: result.changes, cursor: null }
  return { inserted: result.changes, cursor: { createdAt: last.created_at, operationId: last.operation_id } }
}

export function publishValidatedOperationSummary(db: Database, operationId: string, restoreReadyMarker: boolean): void {
  const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='v3_operation_summaries'").get()
  if (!table) return
  const result = db
    .prepare(
      `UPDATE v3_operation_summaries
       SET ${validatedReadyAssignments},projection_status='ready',projection_error=NULL
       WHERE operation_id=?`,
    )
    .run(operationId)
  if (result.changes !== 1) throw new Error(`[history/v3] missing summary projection for validated operation: ${operationId}`)
  if (restoreReadyMarker) setMeta(db, SUMMARY_PROJECTION_READY_KEY, "1")
}

export function markSummaryProjectionPoisoned(db: Database, operationId: string, reason: string): void {
  db.prepare(
    `UPDATE v3_operation_summaries
     SET projection_status='poisoned',projection_error=?
     WHERE operation_id=?`,
  ).run(reason, operationId)
}

export function inspectSummaryProjectionReadiness(db: Database): SummaryProjectionReadiness {
  const divergence = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT o.operation_id
         FROM v3_operations o
         LEFT JOIN v3_operation_summaries s ON s.operation_id=o.operation_id
         WHERE s.operation_id IS NULL OR NOT (${projectionEquality})
         UNION ALL
         SELECT s.operation_id
         FROM v3_operation_summaries s
         LEFT JOIN v3_operations o ON o.operation_id=s.operation_id
         WHERE o.operation_id IS NULL
       )`,
    )
    .get() as { n: number }
  const statuses = db
    .prepare(
      `SELECT
         SUM(CASE WHEN projection_status='pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN projection_status='poisoned' THEN 1 ELSE 0 END) AS poisoned,
         SUM(CASE WHEN projection_status<>'ready' THEN 1 ELSE 0 END) AS not_ready
       FROM v3_operation_summaries`,
    )
    .get() as { pending: number | null; poisoned: number | null; not_ready: number | null }
  const pending = statuses.pending ?? 0
  const poisoned = statuses.poisoned ?? 0
  return { ready: divergence.n === 0 && (statuses.not_ready ?? 0) === 0, pending, poisoned }
}
