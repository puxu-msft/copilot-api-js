import { generateId } from "../utils"
import type { EntrySummary, HistoryEntry, HistoryState, HistoryStats, Session } from "./types"

export const historyState: HistoryState = {
  enabled: false,
  entries: [],
  sessions: new Map(),
  currentSessionId: "",
  maxEntries: 200,
}

export const historyIndexes = {
  entryIndex: new Map<string, HistoryEntry>(),
  summaryIndex: new Map<string, EntrySummary>(),
  sessionEntryCount: new Map<string, number>(),
  sessionModelsSet: new Map<string, Set<string>>(),
  sessionToolsSet: new Map<string, Set<string>>(),
}

export const historyStatsCache: {
  dirty: boolean
  stats: HistoryStats | null
} = {
  dirty: true,
  stats: null,
}

export function resetHistoryIndexes(): void {
  historyIndexes.entryIndex.clear()
  historyIndexes.summaryIndex.clear()
  historyIndexes.sessionEntryCount.clear()
  historyIndexes.sessionModelsSet.clear()
  historyIndexes.sessionToolsSet.clear()
}

export function invalidateHistoryStats(): void {
  historyStatsCache.dirty = true
  historyStatsCache.stats = null
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

export function initHistory(enabled: boolean, maxEntries: number): void {
  historyState.enabled = enabled
  historyState.maxEntries = maxEntries
  historyState.entries = []
  historyState.sessions = new Map()
  historyState.currentSessionId = enabled ? generateId() : ""
  resetHistoryIndexes()
  invalidateHistoryStats()
}

export function setHistoryMaxEntries(limit: number): void {
  historyState.maxEntries = limit
}

export function isHistoryEnabled(): boolean {
  return historyState.enabled
}

export function resetHistoryStateForClear(): void {
  historyState.entries = []
  historyState.sessions = new Map<string, Session>()
  historyState.currentSessionId = generateId()
  resetHistoryIndexes()
  invalidateHistoryStats()
}
