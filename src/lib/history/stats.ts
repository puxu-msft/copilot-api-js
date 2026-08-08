import type { HistoryStats } from "./types"

import {
  //
  resolveResponseError,
  resolveResponseModel,
  resolveResponseSuccess,
  resolveResponseUsage,
  resolveStopReason,
} from "./entry-view"
import { toEntrySummary } from "./in-flight"
import {
  //
  getHistory,
  listHistoryOverlaySummaries,
} from "./queries"
import { getDatabase } from "./sqlite/connection"
import { visitV3Summaries } from "./v3/store"
import {
  //
  isSummaryProjectionReady,
  queryPersistedStats,
} from "./v3/summary-store"

function formatLocalTimestamp(ts: number): string {
  const date = new Date(ts)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hour = String(date.getHours()).padStart(2, "0")
  const minute = String(date.getMinutes()).padStart(2, "0")
  const second = String(date.getSeconds()).padStart(2, "0")
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  const str = typeof value === "string" ? value : JSON.stringify(value)
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replaceAll('"', '""')}"`
  }
  return str
}

/** The one request-count bucket a summary belongs to. */
export type RequestBucket = "success" | "failure" | "aborted" | "interrupted" | "none"

/**
 * Assign a request to EXACTLY ONE count bucket. Mutual exclusivity is structural (a single return),
 * not four independent `if`s that could each fire.
 *
 * The REQUEST VERDICT is the authority. `responseSuccess` describes the UPSTREAM leg, and it is
 * deliberately `true` for a proxy-introduced failure — a suppressed contentless refusal or an
 * unrepairable tool_use, where the upstream really did deliver a complete 200 that the proxy then
 * re-judged. The previous `state === "completed" || responseSuccess === true` /
 * `state === "failed" || responseSuccess === false` pair incremented BOTH counters for one such
 * request, so success + failure could exceed the total. The leg is consulted ONLY as a fallback,
 * when the entry carries no terminal verdict at all.
 */
export function requestBucket(summary: { state?: string; responseSuccess?: boolean }): RequestBucket {
  switch (summary.state) {
    case "completed": {
      return "success"
    }
    case "failed": {
      return "failure"
    }
    case "aborted": {
      return "aborted"
    }
    case "interrupted": {
      return "interrupted"
    }
    default: {
      if (summary.responseSuccess === true) return "success"
      if (summary.responseSuccess === false) return "failure"
      return "none"
    }
  }
}

export function getStats(): HistoryStats {
  const stats: HistoryStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    abortedRequests: 0,
    interruptedRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    averageDurationMs: 0,
    modelDistribution: {},
    endpointDistribution: {},
    recentActivity: [],
    activeSessions: 0,
  }
  const overlay = listHistoryOverlaySummaries()
  let totalDurationMs = 0
  const sessions = new Set<string>()
  const seen = new Set<string>()
  const db = getDatabase()
  const projectionReady = isSummaryProjectionReady(db)
  if (projectionReady) {
    const persisted = queryPersistedStats(db, [...new Set(overlay.map((summary) => summary.id))])
    Object.assign(stats, persisted.stats)
    totalDurationMs = persisted.totalDurationMs
    for (const sessionId of persisted.sessionIds) sessions.add(sessionId)
  }
  const consume = (summary: ReturnType<typeof toEntrySummary>): void => {
    if (seen.has(summary.id)) return
    seen.add(summary.id)
    stats.totalRequests++
    const bucket = requestBucket(summary)
    switch (bucket) {
      case "success": {
        stats.successfulRequests++
        break
      }
      case "failure": {
        stats.failedRequests++
        break
      }
      case "aborted": {
        stats.abortedRequests++
        break
      }
      case "interrupted": {
        stats.interruptedRequests++
        break
      }
      case "none": {
        break
      }
      default: {
        bucket satisfies never
      }
    }
    const usage = summary.usage
    stats.totalInputTokens += usage?.input_tokens ?? 0
    stats.totalOutputTokens += usage?.output_tokens ?? 0
    totalDurationMs += summary.durationMs ?? 0
    if (summary.sessionId) sessions.add(summary.sessionId)
    const model = summary.responseModel ?? summary.requestModel
    if (model) stats.modelDistribution[model] = (stats.modelDistribution[model] ?? 0) + 1
    stats.endpointDistribution[summary.endpoint] = (stats.endpointDistribution[summary.endpoint] ?? 0) + 1
  }
  for (const summary of overlay) consume(summary)
  if (!projectionReady) visitV3Summaries(consume)
  stats.averageDurationMs = stats.totalRequests === 0 ? 0 : totalDurationMs / stats.totalRequests
  stats.activeSessions = sessions.size
  return stats
}

export function exportHistory(format: "json" | "csv" = "json"): string {
  const entries = getHistory({ limit: 1_000_000, operationKind: "all" }).entries

  if (format === "json") {
    return JSON.stringify({ entries }, null, 2)
  }

  const headers = [
    "id",
    "session_id",
    "started_at",
    "endpoint",
    "request_model",
    "message_count",
    "stream",
    "success",
    "response_model",
    "input_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "duration_ms",
    "stop_reason",
    "error",
  ]

  const rows = entries.map((entry) => {
    const usage = resolveResponseUsage(entry)
    return [
      entry.id,
      entry.sessionId ?? "",
      formatLocalTimestamp(entry.startedAt),
      entry.endpoint,
      entry.clientRequest?.model,
      entry.clientRequest?.messages?.length,
      entry.clientRequest?.stream,
      resolveResponseSuccess(entry),
      resolveResponseModel(entry),
      usage?.input_tokens,
      usage?.cache_read_input_tokens,
      usage?.cache_creation_input_tokens,
      usage?.output_tokens,
      usage?.output_tokens_details?.reasoning_tokens,
      entry.durationMs,
      resolveStopReason(entry),
      resolveResponseError(entry),
    ]
  })

  return [headers.join(","), ...rows.map((row) => row.map((value) => escapeCsvValue(value)).join(","))].join("\n")
}
