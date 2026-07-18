import type {
  //
  EntrySummary,
  HistoryEntry,
  MessageContent,
} from "./types"

import {
  //
  extractResponsePreviewText,
  resolveAttemptCount,
  resolveCurrentStrategy,
  resolveResponseError,
  resolveResponseModel,
  resolveResponseSuccess,
  resolveResponseUsage,
} from "./entry-view"

const entries = new Map<string, HistoryEntry>()

/**
 * Memoized preview + response-preview text per HistoryEntry instance.
 *
 * `extractPreviewText` iterates the messages array and content blocks; for long
 * conversations with frequent SSE-driven `updateInFlight` calls the cost is
 * O(updates × messages × blocks) and the result was previously recomputed on
 * every WebSocket push. `extractResponsePreviewText` likewise iterates the
 * attempts / response content blocks, so it is memoized in the SAME WeakMap cell
 * and shares the entry's invalidation fate. Cache keyed by HistoryEntry identity:
 * each `putInFlight` / `updateInFlight` produces a fresh entry object (due to
 * `{ ...existing, ...patch }`), so the WeakMap entry is naturally invalidated —
 * we compute once per entry instance and never again.
 */
const summaryTextCache = new WeakMap<HistoryEntry, { preview: string; responsePreview: string }>()

function getCachedSummaryText(entry: HistoryEntry): { preview: string; responsePreview: string } {
  const hit = summaryTextCache.get(entry)
  if (hit) return hit
  const computed = { preview: extractPreviewText(entry), responsePreview: extractResponsePreviewText(entry) }
  summaryTextCache.set(entry, computed)
  return computed
}

export function putInFlight(entry: HistoryEntry): void {
  entries.set(entry.id, entry)
}

export function updateInFlight(id: string, patch: Partial<HistoryEntry>): HistoryEntry | undefined {
  const existing = entries.get(id)
  if (!existing) return undefined
  const merged: HistoryEntry = { ...existing, ...patch }
  entries.set(id, merged)
  return merged
}

export function getInFlight(id: string): HistoryEntry | undefined {
  return entries.get(id)
}

export function removeInFlight(id: string): void {
  entries.delete(id)
}

export function listInFlight(): Array<HistoryEntry> {
  return Array.from(entries.values())
}

export function clearInFlight(): void {
  entries.clear()
}

/**
 * Summarize a single message into a preview line (first ~100 chars), or "" when
 * the message yields nothing displayable. Mirrors the project's History-UI
 * principle: show what the message actually IS — text first, then a
 * `[tool_use: …]` / `[tool_result: …]` / `[tool_call: …]` marker — rather than
 * hunting backward for user text.
 */
function summarizeMessage(msg: MessageContent): string {
  // An OpenAI `role:"tool"` message IS a tool result — its string content is raw
  // tool output (noise), so represent it by the `[tool_result: id]` marker per the
  // History-UI principle, ahead of the generic string-content path below.
  if (msg.role === "tool") {
    return `[tool_result: ${msg.tool_call_id ?? msg.name ?? "unknown"}]`.slice(0, 100)
  }

  if (typeof msg.content === "string" && msg.content.length > 0) {
    return msg.content.slice(0, 100)
  }

  if (Array.isArray(msg.content)) {
    let firstToolUse: string | undefined
    let firstToolResult: string | undefined
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue
      const b = block as Record<string, unknown>
      if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
        return b.text.slice(0, 100)
      }
      if (b.type === "tool_use" && firstToolUse === undefined) {
        firstToolUse = `[tool_use: ${typeof b.name === "string" ? b.name : "?"}]`
      }
      if (b.type === "tool_result" && firstToolResult === undefined) {
        firstToolResult = `[tool_result: ${typeof b.tool_use_id === "string" ? b.tool_use_id : "?"}]`
      }
    }
    if (firstToolUse !== undefined) return firstToolUse.slice(0, 100)
    if (firstToolResult !== undefined) return firstToolResult.slice(0, 100)
  }

  // OpenAI assistant tool_calls (no block array carrier).
  if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
    const names = msg.tool_calls.map((toolCall) => toolCall.function.name).join(", ")
    return `[tool_call: ${names}]`.slice(0, 100)
  }

  return ""
}

/**
 * Preview = a faithful summary of the LAST message (first ~100 chars). When the
 * last message yields nothing displayable (e.g. empty), scan backward for the
 * most recent non-empty summary so the list stays readable. "" only when
 * nothing is summarizable.
 *
 * Reads ONLY `clientRequest.messages`. The `Pick<…, "clientRequest">` param
 * keeps that contract explicit.
 */
export function extractPreviewText(entry: Pick<HistoryEntry, "clientRequest">): string {
  const messages = entry.clientRequest?.messages
  if (!messages || messages.length === 0) return ""

  for (let i = messages.length - 1; i >= 0; i--) {
    const summary = summarizeMessage(messages[i])
    if (summary) return summary
  }

  return ""
}

/**
 * Produce the same summary shape as the memory-based `toSummary()` in
 * `src/lib/history/entries.ts`. Duplication is intentionally temporary —
 * Task 8 will remove the entries.ts version.
 */
export function toEntrySummary(entry: HistoryEntry): EntrySummary {
  const cached = getCachedSummaryText(entry)
  return {
    id: entry.id,
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    rawPath: entry.rawPath,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    endpoint: entry.endpoint,
    state: entry.state,
    active: entry.active,
    pinned: entry.pinned,
    lastUpdatedAt: entry.lastUpdatedAt,
    queueWaitMs: entry.queueWaitMs,
    attemptCount: resolveAttemptCount(entry),
    currentStrategy: resolveCurrentStrategy(entry),
    pid: entry.process?.pid,
    requestModel: entry.clientRequest?.model,
    stream: entry.clientRequest?.stream,
    messageCount: entry.clientRequest?.messages?.length ?? 0,
    responseModel: resolveResponseModel(entry),
    responseSuccess: resolveResponseSuccess(entry),
    responseError: resolveResponseError(entry) ?? entry._index?.derived?.failureReason,
    usage: resolveResponseUsage(entry),
    durationMs: entry.durationMs,
    requestBytes: entry.requestBytes,
    responseBytes: entry.responseBytes,
    multiplier: entry.multiplier,
    previewText: cached.preview,
    responsePreviewText: cached.responsePreview,
  }
}
