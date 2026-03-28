import { generateId } from "../utils"
import { getStats } from "./stats"
import { historyIndexes, historyState, invalidateHistoryStats, resetHistoryIndexes } from "./state"
import type { EntrySummary, HistoryEntry } from "./types"
import { notifyEntryAdded, notifyEntryUpdated, notifyHistoryCleared, notifyStatsUpdated } from "./ws"

/** Extract a preview from the last user message (first 100 chars) */
function extractPreviewText(entry: HistoryEntry): string {
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

function buildSearchText(entry: HistoryEntry): string {
  const parts: Array<string> = []

  if (entry.request.model) parts.push(entry.request.model)
  if (entry.response?.model) parts.push(entry.response.model)
  if (entry.response?.error) parts.push(entry.response.error)

  if (entry.request.system) {
    if (typeof entry.request.system === "string") {
      parts.push(entry.request.system.slice(0, 500))
    } else {
      for (const block of entry.request.system) {
        parts.push(block.text.slice(0, 200))
      }
    }
  }

  if (entry.request.messages) {
    for (const msg of entry.request.messages) {
      if (typeof msg.content === "string") {
        parts.push(msg.content.slice(0, 200))
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            parts.push((block.text as string).slice(0, 200))
          } else if (block.type === "tool_use") {
            if (block.name) parts.push(block.name as string)
            if (block.input) {
              const inputStr = typeof block.input === "string" ? block.input : JSON.stringify(block.input)
              parts.push(inputStr.slice(0, 500))
            }
          } else if (block.type === "tool_result" && block.content) {
            const contentStr = typeof block.content === "string" ? block.content : JSON.stringify(block.content)
            parts.push(contentStr.slice(0, 500))
          } else if (block.type === "thinking" && block.thinking) {
            parts.push((block.thinking as string).slice(0, 200))
          }
        }
      }

      if (msg.tool_calls) {
        for (const toolCall of msg.tool_calls) {
          if (toolCall.function.name) parts.push(toolCall.function.name)
          if (toolCall.function.arguments) parts.push(toolCall.function.arguments.slice(0, 500))
        }
      }
    }
  }

  if (entry.response?.content) {
    const responseContent = entry.response.content
    if (typeof responseContent.content === "string") {
      parts.push(responseContent.content.slice(0, 200))
    } else if (Array.isArray(responseContent.content)) {
      for (const block of responseContent.content) {
        if (block.type === "text" && block.text) {
          parts.push((block.text as string).slice(0, 200))
        } else if (block.type === "tool_use" && block.name) {
          parts.push(block.name as string)
        }
      }
    }
  }

  return parts.join(" ").toLowerCase()
}

function toSummary(entry: HistoryEntry): EntrySummary {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    timestamp: entry.timestamp,
    endpoint: entry.endpoint,
    requestModel: entry.request.model,
    stream: entry.request.stream,
    messageCount: entry.request.messages?.length ?? 0,
    responseModel: entry.response?.model,
    responseSuccess: entry.response?.success,
    responseError: entry.response?.error,
    usage: entry.response?.usage,
    durationMs: entry.durationMs,
    previewText: extractPreviewText(entry),
    searchText: "",
  }
}

export function ensureSearchText(id: string): string {
  const summary = historyIndexes.summaryIndex.get(id)
  if (!summary) return ""
  if (summary.searchText === "") {
    const entry = historyIndexes.entryIndex.get(id)
    if (entry) {
      summary.searchText = buildSearchText(entry)
    }
  }
  return summary.searchText
}

function updateSessionMetadata(entry: HistoryEntry): void {
  const session = historyState.sessions.get(entry.sessionId)
  if (!session) return

  const model = entry.request.model
  if (model) {
    const modelsSet = historyIndexes.sessionModelsSet.get(entry.sessionId)
    if (modelsSet && !modelsSet.has(model)) {
      modelsSet.add(model)
      session.models.push(model)
    }
  }

  if (entry.request.tools && entry.request.tools.length > 0) {
    if (!session.toolsUsed) {
      session.toolsUsed = []
    }
    let toolsSet = historyIndexes.sessionToolsSet.get(entry.sessionId)
    if (!toolsSet) {
      toolsSet = new Set(session.toolsUsed)
      historyIndexes.sessionToolsSet.set(entry.sessionId, toolsSet)
    }
    for (const tool of entry.request.tools) {
      if (!toolsSet.has(tool.name)) {
        toolsSet.add(tool.name)
        session.toolsUsed.push(tool.name)
      }
    }
  }
}

function removeOldestEntries(count: number): number {
  if (count <= 0 || historyState.entries.length === 0) return 0

  const actualCount = Math.min(count, historyState.entries.length)
  const removed = historyState.entries.splice(0, actualCount)
  for (const entry of removed) {
    historyIndexes.entryIndex.delete(entry.id)
    historyIndexes.summaryIndex.delete(entry.id)
    const sessionCount = (historyIndexes.sessionEntryCount.get(entry.sessionId) ?? 1) - 1
    if (sessionCount <= 0) {
      historyIndexes.sessionEntryCount.delete(entry.sessionId)
      historyIndexes.sessionModelsSet.delete(entry.sessionId)
      historyIndexes.sessionToolsSet.delete(entry.sessionId)
      historyState.sessions.delete(entry.sessionId)
    } else {
      historyIndexes.sessionEntryCount.set(entry.sessionId, sessionCount)
    }
  }

  if (removed.length > 0) {
    invalidateHistoryStats()
  }

  return removed.length
}

export function evictOldestEntries(count: number): number {
  const evicted = removeOldestEntries(count)
  if (evicted > 0) {
    notifyStatsUpdated(getStats())
  }
  return evicted
}

export function insertEntry(entry: HistoryEntry): void {
  if (!historyState.enabled) return

  const session = historyState.sessions.get(entry.sessionId)
  if (!session) return

  historyState.entries.push(entry)
  historyIndexes.entryIndex.set(entry.id, entry)
  session.requestCount++
  historyIndexes.sessionEntryCount.set(entry.sessionId, (historyIndexes.sessionEntryCount.get(entry.sessionId) ?? 0) + 1)

  updateSessionMetadata(entry)

  const summary = toSummary(entry)
  historyIndexes.summaryIndex.set(entry.id, summary)

  if (historyState.maxEntries > 0 && historyState.entries.length > historyState.maxEntries) {
    removeOldestEntries(historyState.entries.length - historyState.maxEntries)
  }

  invalidateHistoryStats()
  notifyEntryAdded(summary)
  notifyStatsUpdated(getStats())
}

export function updateEntry(
  id: string,
  update: Partial<
    Pick<
      HistoryEntry,
      "request" | "response" | "pipelineInfo" | "sseEvents" | "durationMs" | "effectiveRequest" | "wireRequest" | "attempts"
    >
  >,
): void {
  if (!historyState.enabled) return

  const entry = historyIndexes.entryIndex.get(id)
  if (!entry) return

  if (update.request) {
    entry.request = update.request
    updateSessionMetadata(entry)
  }
  if (update.response) entry.response = update.response
  if (update.pipelineInfo) entry.pipelineInfo = update.pipelineInfo
  if (update.durationMs !== undefined) entry.durationMs = update.durationMs
  if (update.sseEvents) entry.sseEvents = update.sseEvents
  if (update.effectiveRequest) entry.effectiveRequest = update.effectiveRequest
  if (update.wireRequest) entry.wireRequest = update.wireRequest
  if (update.attempts) entry.attempts = update.attempts

  if (update.response) {
    const session = historyState.sessions.get(entry.sessionId)
    if (session) {
      session.totalInputTokens += update.response.usage.input_tokens
      session.totalOutputTokens += update.response.usage.output_tokens
      session.lastActivity = Date.now()
    }
  }

  invalidateHistoryStats()
  const summary = toSummary(entry)
  historyIndexes.summaryIndex.set(entry.id, summary)
  notifyEntryUpdated(summary)
  notifyStatsUpdated(getStats())
}

export function clearHistory(): void {
  historyState.entries = []
  historyState.sessions = new Map()
  historyState.currentSessionId = generateId()
  resetHistoryIndexes()
  invalidateHistoryStats()
  notifyHistoryCleared()
  notifyStatsUpdated(getStats())
}
