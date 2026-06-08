import type { EntrySummary } from "@/types"

import { formatNumber } from "./formatters"

export function requestState(entry: EntrySummary): string {
  if (entry.state) return entry.state
  if (entry.responseSuccess === false) return "failed"
  if (entry.responseSuccess) return "completed"
  return "pending"
}

export function statusIcon(entry: EntrySummary): string {
  const state = requestState(entry)
  if (state === "completed") return "mdi-check-circle"
  if (state === "failed") return "mdi-close-circle"
  if (state === "streaming") return "mdi-waveform"
  if (state === "executing") return "mdi-progress-clock"
  return "mdi-clock-outline"
}

export function statusColor(entry: EntrySummary): string {
  const state = requestState(entry)
  if (state === "completed") return "success"
  if (state === "failed") return "error"
  if (state === "streaming") return "info"
  if (state === "executing") return "warning"
  return "secondary"
}

export function modelName(entry: EntrySummary): string {
  return entry.responseModel || entry.requestModel || "-"
}

export function endpointLabel(entry: EntrySummary): string {
  if (entry.rawPath) return entry.rawPath
  return entry.endpoint
    .replace(/^\/v\d+\//, "")
    .replaceAll("/", " ")
    .replaceAll("-", " ")
}

export function tokenIn(entry: EntrySummary): string {
  if (!entry.usage) return "-"
  return formatNumber(entry.usage.input_tokens)
}

export function tokenOut(entry: EntrySummary): string {
  if (!entry.usage) return "-"
  return formatNumber(entry.usage.output_tokens)
}

export function truncPreview(entry: EntrySummary): string {
  const text = entry.previewText || entry.responseError || ""
  if (text.length <= 120) return text
  return text.slice(0, 117) + "..."
}

/** 在途请求的诊断摘要(策略 / 重试 / 排队),用于在途区 Preview 列 */
export function inflightDetail(entry: EntrySummary): string {
  const parts: Array<string> = []
  if (entry.currentStrategy) parts.push(entry.currentStrategy)
  if (entry.attemptCount && entry.attemptCount > 1) parts.push(`attempt ${entry.attemptCount}`)
  if (entry.queueWaitMs && entry.queueWaitMs > 0) parts.push(`queued ${Math.round(entry.queueWaitMs / 1000)}s`)
  return parts.join(" · ")
}
