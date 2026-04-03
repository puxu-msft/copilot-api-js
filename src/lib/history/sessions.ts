import { notifySessionDeleted, notifyStatsUpdated } from "../ws"
import { historyIndexes, historyState, invalidateHistoryStats } from "./state"
import { getStats } from "./stats"
import type { CursorResult, EndpointType, HistoryEntry, Session, SessionResult } from "./types"

const SESSION_HEADER_CANDIDATES = [
  "x-session-id",
  "x-conversation-id",
  "x-chat-session-id",
  "x-thread-id",
  "x-interaction-id",
] as const

function normalizeSessionId(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function ensureSession(sessionId: string, endpoint: EndpointType): Session {
  const existing = historyState.sessions.get(sessionId)
  if (existing) {
    existing.lastActivity = Date.now()
    if (!existing.endpoints.includes(endpoint)) {
      existing.endpoints.push(endpoint)
    }
    historyState.currentSessionId = sessionId
    return existing
  }

  const now = Date.now()
  const session: Session = {
    id: sessionId,
    startTime: now,
    lastActivity: now,
    requestCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    models: [],
    endpoints: [endpoint],
  }

  historyState.sessions.set(sessionId, session)
  historyIndexes.sessionModelsSet.set(sessionId, new Set())
  historyIndexes.sessionToolsSet.set(sessionId, new Set())
  historyState.currentSessionId = sessionId
  return session
}

export function getSessionIdFromHeaders(headers: Headers | Record<string, string | undefined>): string | undefined {
  for (const name of SESSION_HEADER_CANDIDATES) {
    const value = headers instanceof Headers ? headers.get(name) : headers[name]
    const normalized = normalizeSessionId(value)
    if (normalized) return normalized
  }
  return undefined
}

export function resolveResponseSessionId(previousResponseId: string | null | undefined): string | undefined {
  const normalized = normalizeSessionId(previousResponseId)
  if (!normalized) return undefined
  return historyIndexes.responseSessionIndex.get(normalized) ?? normalized
}

export function registerResponseSession(responseId: string | null | undefined, sessionId: string | undefined): void {
  const normalizedResponseId = normalizeSessionId(responseId)
  const normalizedSessionId = normalizeSessionId(sessionId)
  if (!normalizedResponseId || !normalizedSessionId) return
  historyIndexes.responseSessionIndex.set(normalizedResponseId, normalizedSessionId)
}

/**
 * Get or create a tracked session when the caller has a real session identifier.
 * Returns undefined when no trustworthy identifier is available.
 */
export function getCurrentSession(endpoint: EndpointType, sessionId?: string): string | undefined {
  const normalized = normalizeSessionId(sessionId)
  if (!normalized) return undefined
  ensureSession(normalized, endpoint)
  return normalized
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
  const all = historyState.entries.filter((entry) => entry.sessionId === sessionId).sort((a, b) => a.startedAt - b.startedAt)

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

  for (const [responseId, mappedSessionId] of historyIndexes.responseSessionIndex) {
    if (mappedSessionId === sessionId) {
      historyIndexes.responseSessionIndex.delete(responseId)
    }
  }

  invalidateHistoryStats()

  if (historyState.currentSessionId === sessionId) {
    historyState.currentSessionId = ""
  }

  notifySessionDeleted(sessionId)
  notifyStatsUpdated(getStats())
  return true
}
