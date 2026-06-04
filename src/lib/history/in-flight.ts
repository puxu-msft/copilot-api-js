import type {
  //
  EntrySummary,
  HistoryEntry,
} from "./types"

const entries = new Map<string, HistoryEntry>()

/**
 * Memoized preview/search text per HistoryEntry instance.
 *
 * `extractPreviewText` / `extractSearchText` iterate the entire messages array
 * and every content block; for long conversations with frequent SSE-driven
 * `updateInFlight` calls (attempt count, queueWaitMs, pipelineInfo changes),
 * the cost is O(updates × messages × blocks) and the result was previously
 * recomputed on every WebSocket push. Cache keyed by HistoryEntry identity:
 * each `putInFlight` / `updateInFlight` produces a fresh entry object (due to
 * `{ ...existing, ...patch }`), so the WeakMap entry is naturally invalidated
 * — we compute once per entry instance and never again.
 */
const summaryTextCache = new WeakMap<HistoryEntry, { preview: string; search: string }>()

function getCachedSummaryText(entry: HistoryEntry): { preview: string; search: string } {
  const hit = summaryTextCache.get(entry)
  if (hit) return hit
  const computed = {
    preview: extractPreviewText(entry),
    search: extractSearchText(entry),
  }
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

/** Extract a preview from the last user message (first 100 chars) */
export function extractPreviewText(entry: HistoryEntry): string {
  const messages = entry.request.messages
  if (!messages || messages.length === 0) return ""

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "tool") continue
    if (msg.role !== "user") continue

    if (typeof msg.content === "string") {
      return msg.content.slice(0, 100)
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          return (block.text as string).slice(0, 100)
        }
        if (block.type === "tool_result") {
          break
        }
      }
      continue
    }
    break
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const names = msg.tool_calls.map((toolCall) => toolCall.function.name).join(", ")
      return `[tool_call: ${names}]`.slice(0, 100)
    }
    if (msg.role === "tool") {
      return `[tool_result: ${msg.tool_call_id ?? msg.name ?? "unknown"}]`.slice(0, 100)
    }
    break
  }

  return ""
}

/** Build a searchable text blob from request/response fields */
export function extractSearchText(entry: HistoryEntry): string {
  const parts: Array<string> = []
  if (entry.request.model) parts.push(entry.request.model)
  if (entry.response?.model) parts.push(entry.response.model)
  parts.push(entry.endpoint)
  if (entry.response?.error) parts.push(entry.response.error)

  const system = entry.request.system
  if (typeof system === "string") parts.push(system)
  else if (Array.isArray(system)) {
    for (const block of system) {
      if (typeof block === "object" && "text" in block && typeof block.text === "string") {
        parts.push(block.text)
      }
    }
  }

  const messages = entry.request.messages ?? []
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      parts.push(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue
        const b = block as Record<string, unknown>
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text)
        else if (b.type === "tool_use" && typeof b.name === "string") parts.push(b.name)
        else if (b.type === "tool_result" && typeof b.content === "string") parts.push(b.content)
      }
    }
    const toolCalls = (msg as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (tc.function?.name) parts.push(tc.function.name)
      }
    }
  }

  return parts.join(" ")
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
    rawPath: entry.rawPath,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    endpoint: entry.endpoint,
    state: entry.state,
    active: entry.active,
    lastUpdatedAt: entry.lastUpdatedAt,
    queueWaitMs: entry.queueWaitMs,
    attemptCount: entry.attemptCount,
    currentStrategy: entry.currentStrategy,
    requestModel: entry.request.model,
    stream: entry.request.stream,
    messageCount: entry.request.messages?.length ?? 0,
    responseModel: entry.response?.model,
    responseSuccess: entry.response?.success,
    responseError: entry.response?.error,
    usage: entry.response?.usage,
    durationMs: entry.durationMs,
    previewText: cached.preview,
    searchText: cached.search,
  }
}
