import type { HistoryStats } from "./types"

import { listInFlight } from "./in-flight"
import {
  //
  listSessions,
  queryEntries,
} from "./sqlite/read"
import { computeStats } from "./sqlite/stats"

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
  const base = computeStats()
  const inFlight = listInFlight()
  if (inFlight.length === 0) return base

  const modelDistribution = { ...base.modelDistribution }
  const endpointDistribution = { ...base.endpointDistribution }
  let totalInputTokens = base.totalInputTokens
  let totalOutputTokens = base.totalOutputTokens
  let successful = base.successfulRequests
  let failed = base.failedRequests

  for (const entry of inFlight) {
    const model = entry.outboundResponse?.model ?? entry.inboundRequest.model
    if (model) modelDistribution[model] = (modelDistribution[model] ?? 0) + 1
    endpointDistribution[entry.endpoint] = (endpointDistribution[entry.endpoint] ?? 0) + 1
    totalInputTokens += entry.outboundResponse?.usage.input_tokens ?? 0
    totalOutputTokens += entry.outboundResponse?.usage.output_tokens ?? 0
    if (entry.outboundResponse?.success === true) successful += 1
    else if (entry.outboundResponse?.success === false) failed += 1
  }

  return {
    ...base,
    totalRequests: base.totalRequests + inFlight.length,
    successfulRequests: successful,
    failedRequests: failed,
    totalInputTokens,
    totalOutputTokens,
    modelDistribution,
    endpointDistribution,
  }
}

export function exportHistory(format: "json" | "csv" = "json"): string {
  const entries = queryEntries({ limit: 1_000_000 })
  const sessions = listSessions()

  if (format === "json") {
    return JSON.stringify({ sessions, entries }, null, 2)
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
    "output_tokens",
    "duration_ms",
    "stop_reason",
    "error",
  ]

  const rows = entries.map((entry) => [
    entry.id,
    entry.sessionId ?? "",
    formatLocalTimestamp(entry.startedAt),
    entry.endpoint,
    entry.inboundRequest.model,
    entry.inboundRequest.messages?.length,
    entry.inboundRequest.stream,
    entry.outboundResponse?.success,
    entry.outboundResponse?.model,
    entry.outboundResponse?.usage.input_tokens,
    entry.outboundResponse?.usage.output_tokens,
    entry.durationMs,
    entry.outboundResponse?.stop_reason,
    entry.outboundResponse?.error,
  ])

  return [headers.join(","), ...rows.map((row) => row.map((value) => escapeCsvValue(value)).join(","))].join("\n")
}
