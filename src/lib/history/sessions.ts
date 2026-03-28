import { generateId } from "../utils"
import { historyIndexes, historyState, invalidateHistoryStats } from "./state"
import type { CursorResult, EndpointType, HistoryEntry, Session, SessionResult } from "./types"
import { notifySessionDeleted, notifyStatsChanged } from "./ws"

/**
 * Get or create current session.
 * Currently treats all requests as belonging to one session per server lifetime,
 * since clients don't provide session identifiers yet.
 * TODO: When clients support session headers, use that to group requests.
 */
export function getCurrentSession(endpoint: EndpointType): string {
  if (historyState.currentSessionId) {
    const session = historyState.sessions.get(historyState.currentSessionId)
    if (session) {
      session.lastActivity = Date.now()
      if (!session.endpoints.includes(endpoint)) {
        session.endpoints.push(endpoint)
      }
      return historyState.currentSessionId
    }
  }

  const now = Date.now()
  const sessionId = generateId()
  historyState.currentSessionId = sessionId
  historyIndexes.sessionModelsSet.set(sessionId, new Set())
  historyIndexes.sessionToolsSet.set(sessionId, new Set())
  historyState.sessions.set(sessionId, {
    id: sessionId,
    startTime: now,
    lastActivity: now,
    requestCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    models: [],
    endpoints: [endpoint],
  })

  return sessionId
}

export function getSessions(): SessionResult {
  const sessions = Array.from(historyState.sessions.values()).sort((a, b) => b.lastActivity - a.lastActivity)
  return {
    sessions,
    total: sessions.length,
  }
}

export function getSession(id: string): Session | undefined {
  return historyState.sessions.get(id)
}

export function getSessionEntries(sessionId: string, options: { cursor?: string; limit?: number } = {}): CursorResult<HistoryEntry> {
  const { cursor, limit = 50 } = options
  const all = historyState.entries.filter((entry) => entry.sessionId === sessionId).sort((a, b) => a.timestamp - b.timestamp)

  const total = all.length
  let startIdx = 0
  if (cursor) {
    const cursorIdx = all.findIndex((entry) => entry.id === cursor)
    if (cursorIdx !== -1) startIdx = cursorIdx + 1
  }

  const entries = all.slice(startIdx, startIdx + limit)
  const nextCursor = startIdx + limit < total ? (entries.at(-1)?.id ?? null) : null
  const prevCursor = startIdx > 0 ? (entries[0]?.id ?? null) : null

  return { entries, total, nextCursor, prevCursor }
}

export function deleteSession(sessionId: string): boolean {
  if (!historyState.sessions.has(sessionId)) {
    return false
  }

  const remaining: Array<HistoryEntry> = []
  for (const entry of historyState.entries) {
    if (entry.sessionId === sessionId) {
      historyIndexes.entryIndex.delete(entry.id)
      historyIndexes.summaryIndex.delete(entry.id)
    } else {
      remaining.push(entry)
    }
  }

  historyState.entries = remaining
  historyState.sessions.delete(sessionId)
  historyIndexes.sessionEntryCount.delete(sessionId)
  historyIndexes.sessionModelsSet.delete(sessionId)
  historyIndexes.sessionToolsSet.delete(sessionId)
  invalidateHistoryStats()

  if (historyState.currentSessionId === sessionId) {
    historyState.currentSessionId = generateId()
  }

  notifySessionDeleted(sessionId)
  notifyStatsChanged()
  return true
}
