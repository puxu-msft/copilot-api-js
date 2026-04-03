import type { EntrySummary, HistoryEntry } from "./types"

import { notifyEntryAdded, notifyEntryUpdated, notifyHistoryCleared, notifyStatsUpdated } from "../ws"
import { historyIndexes, historyState, invalidateHistoryStats, resetHistoryIndexes } from "./state"
import { getCurrentSession } from "./sessions"
import { getStats } from "./stats"

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

function toSummary(entry: HistoryEntry): EntrySummary {
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
    previewText: extractPreviewText(entry),
    searchText: "",
  }
}

function updateSessionMetadata(entry: HistoryEntry): void {
  if (!entry.sessionId) return
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

function attachEntryToSession(entry: HistoryEntry): void {
  if (!entry.sessionId) return
  const sessionId = getCurrentSession(entry.endpoint, entry.sessionId)
  if (!sessionId) return

  const session = historyState.sessions.get(sessionId)
  if (!session) return

  entry.sessionId = sessionId
  session.requestCount++
  historyIndexes.sessionEntryCount.set(
    sessionId,
    (historyIndexes.sessionEntryCount.get(sessionId) ?? 0) + 1,
  )
  updateSessionMetadata(entry)
}

function detachEntryFromSession(entry: HistoryEntry): void {
  if (!entry.sessionId) return
  const sessionId = entry.sessionId
  const session = historyState.sessions.get(sessionId)
  if (session) {
    session.requestCount = Math.max(0, session.requestCount - 1)
  }

  const sessionCount = (historyIndexes.sessionEntryCount.get(sessionId) ?? 1) - 1
  if (sessionCount <= 0) {
    historyIndexes.sessionEntryCount.delete(sessionId)
    historyIndexes.sessionModelsSet.delete(sessionId)
    historyIndexes.sessionToolsSet.delete(sessionId)
    historyState.sessions.delete(sessionId)
  } else {
    historyIndexes.sessionEntryCount.set(sessionId, sessionCount)
  }
}

function removeOldestEntries(count: number): number {
  if (count <= 0 || historyState.entries.length === 0) return 0

  const actualCount = Math.min(count, historyState.entries.length)
  const removed = historyState.entries.splice(0, actualCount)
  for (const entry of removed) {
    historyIndexes.entryIndex.delete(entry.id)
    historyIndexes.summaryIndex.delete(entry.id)
    detachEntryFromSession(entry)
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

  historyState.entries.push(entry)
  historyIndexes.entryIndex.set(entry.id, entry)
  attachEntryToSession(entry)

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
      | "rawPath"
      | "sessionId"
      | "state"
      | "active"
      | "lastUpdatedAt"
      | "queueWaitMs"
      | "attemptCount"
      | "currentStrategy"
      | "request"
      | "response"
      | "pipelineInfo"
      | "sseEvents"
      | "durationMs"
      | "rawPath"
      | "startedAt"
      | "endedAt"
      | "effectiveRequest"
      | "wireRequest"
      | "attempts"
      | "transport"
      | "warningMessages"
    >
  >,
): void {
  if (!historyState.enabled) return

  const entry = historyIndexes.entryIndex.get(id)
  if (!entry) return

  if (update.sessionId !== undefined && update.sessionId !== entry.sessionId) {
    detachEntryFromSession(entry)
    entry.sessionId = update.sessionId
    attachEntryToSession(entry)
  }
  if (update.request) {
    entry.request = update.request
    updateSessionMetadata(entry)
  }
  if (update.rawPath !== undefined) entry.rawPath = update.rawPath
  if (update.state !== undefined) entry.state = update.state
  if (update.active !== undefined) entry.active = update.active
  if (update.lastUpdatedAt !== undefined) entry.lastUpdatedAt = update.lastUpdatedAt
  if (update.queueWaitMs !== undefined) entry.queueWaitMs = update.queueWaitMs
  if (update.attemptCount !== undefined) entry.attemptCount = update.attemptCount
  if (update.currentStrategy !== undefined) entry.currentStrategy = update.currentStrategy
  if (update.response) entry.response = update.response
  if (update.pipelineInfo) entry.pipelineInfo = update.pipelineInfo
  if (update.durationMs !== undefined) entry.durationMs = update.durationMs
  if (update.startedAt !== undefined) entry.startedAt = update.startedAt
  if (update.endedAt !== undefined) entry.endedAt = update.endedAt
  if (update.transport !== undefined) entry.transport = update.transport
  if (update.sseEvents) entry.sseEvents = update.sseEvents
  if (update.effectiveRequest) entry.effectiveRequest = update.effectiveRequest
  if (update.wireRequest) entry.wireRequest = update.wireRequest
  if (update.attempts) entry.attempts = update.attempts
  if (update.warningMessages) entry.warningMessages = update.warningMessages

  if (update.response) {
    const session = entry.sessionId ? historyState.sessions.get(entry.sessionId) : undefined
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
  historyState.currentSessionId = ""
  resetHistoryIndexes()
  invalidateHistoryStats()
  notifyHistoryCleared()
  notifyStatsUpdated(getStats())
}
