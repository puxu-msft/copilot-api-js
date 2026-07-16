import type { HistoryStats } from "./types"

import {
  //
  resolveResponseError,
  resolveResponseModel,
  resolveResponseSuccess,
  resolveResponseUsage,
  resolveStopReason,
} from "./entry-view"
import { getHistory } from "./queries"

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

export function getStats(): HistoryStats {
  const entries = getHistory({ limit: 1_000_000, operationKind: "all" }).entries
  const stats: HistoryStats = {
    totalRequests: entries.length,
    successfulRequests: entries.filter((entry) => entry.state === "completed" || resolveResponseSuccess(entry) === true).length,
    failedRequests: entries.filter((entry) => entry.state === "failed" || resolveResponseSuccess(entry) === false).length,
    abortedRequests: entries.filter((entry) => entry.state === "aborted").length,
    interruptedRequests: entries.filter((entry) => entry.state === "interrupted").length,
    totalInputTokens: entries.reduce((sum, entry) => sum + (resolveResponseUsage(entry)?.input_tokens ?? 0), 0),
    totalOutputTokens: entries.reduce((sum, entry) => sum + (resolveResponseUsage(entry)?.output_tokens ?? 0), 0),
    averageDurationMs: entries.length === 0 ? 0 : entries.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0) / entries.length,
    modelDistribution: {},
    endpointDistribution: {},
    recentActivity: [],
    activeSessions: new Set(entries.map((entry) => entry.sessionId).filter(Boolean)).size,
  }
  for (const entry of entries) {
    const model = resolveResponseModel(entry) ?? entry.clientRequest?.model
    if (model) stats.modelDistribution[model] = (stats.modelDistribution[model] ?? 0) + 1
    stats.endpointDistribution[entry.endpoint] = (stats.endpointDistribution[entry.endpoint] ?? 0) + 1
  }
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
