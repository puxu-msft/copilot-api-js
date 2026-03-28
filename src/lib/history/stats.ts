import { historyStatsCache, historyState } from "./state"
import type { HistoryStats } from "./types"

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
  if (!historyStatsCache.dirty && historyStatsCache.stats) return historyStatsCache.stats

  const entries = historyState.entries
  const modelDist: Record<string, number> = {}
  const endpointDist: Record<string, number> = {}
  const hourlyActivity: Record<string, number> = {}

  let totalInput = 0
  let totalOutput = 0
  let totalDuration = 0
  let durationCount = 0
  let successCount = 0
  let failCount = 0

  for (const entry of entries) {
    const model = entry.response?.model || entry.request.model || "unknown"
    modelDist[model] = (modelDist[model] || 0) + 1
    endpointDist[entry.endpoint] = (endpointDist[entry.endpoint] || 0) + 1

    const date = new Date(entry.timestamp)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const day = String(date.getDate()).padStart(2, "0")
    const hour = String(date.getHours()).padStart(2, "0")
    const hourKey = `${year}-${month}-${day}T${hour}`
    hourlyActivity[hourKey] = (hourlyActivity[hourKey] || 0) + 1

    if (entry.response) {
      if (entry.response.success) {
        successCount++
      } else {
        failCount++
      }
      totalInput += entry.response.usage.input_tokens
      totalOutput += entry.response.usage.output_tokens
    }

    if (entry.durationMs) {
      totalDuration += entry.durationMs
      durationCount++
    }
  }

  const recentActivity = Object.entries(hourlyActivity)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-24)
    .map(([hour, count]) => ({ hour, count }))

  const stats: HistoryStats = {
    totalRequests: entries.length,
    successfulRequests: successCount,
    failedRequests: failCount,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    averageDurationMs: durationCount > 0 ? totalDuration / durationCount : 0,
    modelDistribution: modelDist,
    endpointDistribution: endpointDist,
    recentActivity,
    activeSessions: historyState.sessions.size,
  }

  historyStatsCache.dirty = false
  historyStatsCache.stats = stats
  return stats
}

export function exportHistory(format: "json" | "csv" = "json"): string {
  if (format === "json") {
    return JSON.stringify(
      {
        sessions: Array.from(historyState.sessions.values()),
        entries: historyState.entries,
      },
      null,
      2,
    )
  }

  const headers = [
    "id",
    "session_id",
    "timestamp",
    "endpoint",
    "request_model",
    "message_count",
    "stream",
    "success",
    "response_model",
    "input_tokens",
    "output_tokens",
    "duration_ms",
    "stop_reason",
    "error",
  ]

  const rows = historyState.entries.map((entry) => [
    entry.id,
    entry.sessionId,
    formatLocalTimestamp(entry.timestamp),
    entry.endpoint,
    entry.request.model,
    entry.request.messages?.length,
    entry.request.stream,
    entry.response?.success,
    entry.response?.model,
    entry.response?.usage.input_tokens,
    entry.response?.usage.output_tokens,
    entry.durationMs,
    entry.response?.stop_reason,
    entry.response?.error,
  ])

  return [headers.join(","), ...rows.map((row) => row.map((value) => escapeCsvValue(value)).join(","))].join("\n")
}
