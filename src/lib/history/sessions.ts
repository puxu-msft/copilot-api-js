import consola from "consola"

import type {
  //
  CursorResult,
  EndpointType,
  HistoryEntry,
  Session,
  SessionResult,
} from "./types"

import {
  //
  listInFlight,
  removeInFlight,
} from "./in-flight"
import {
  //
  getSessionById,
  listSessions,
  queryEntries,
  resolveResponseSession,
} from "./sqlite/read"
import { computeStats } from "./sqlite/stats"
import {
  //
  deleteSession as sqliteDeleteSession,
  upsertResponseSession,
} from "./sqlite/write"
import { historyState } from "./state"

// `x-claude-code-session-id` is what Claude Code actually sends (a stable per-conversation UUID,
// reused across every request in the session) — it must lead the list so anthropic traffic aggregates.
const SESSION_HEADER_CANDIDATES = [
  "x-claude-code-session-id",
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
  return resolveResponseSession(normalized) ?? normalized
}

export function registerResponseSession(responseId: string | null | undefined, sessionId: string | undefined): void {
  const normalizedResponseId = normalizeSessionId(responseId)
  const normalizedSessionId = normalizeSessionId(sessionId)
  if (!normalizedResponseId || !normalizedSessionId) return
  upsertResponseSession(normalizedResponseId, normalizedSessionId)
}

/**
 * Return the normalized session id when the caller has a real session identifier.
 *
 * Returns undefined when no trustworthy identifier is available. The SQLite
 * session row is created on entry completion by `insertCompletedEntry`, so no
 * eager session-map tracking is necessary here.
 */
export function getCurrentSession(_endpoint: EndpointType, sessionId?: string): string | undefined {
  return normalizeSessionId(sessionId)
}

export function getSessions(): SessionResult {
  const sessions = listSessions()
  return {
    sessions,
    total: sessions.length,
  }
}

export function getSession(id: string): Session | undefined {
  return getSessionById(id)
}

export function getSessionEntries(sessionId: string, options: { cursor?: string; limit?: number } = {}): CursorResult<HistoryEntry> {
  const { cursor, limit = 50 } = options
  const all = queryEntries({ sessionId, limit: 1_000_000 }).sort((a, b) => a.startedAt - b.startedAt)

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
  const existed = getSessionById(sessionId) !== undefined
  const deleted = sqliteDeleteSession(sessionId)

  // Also remove any in-flight entries belonging to this session
  const inFlightMatches = listInFlight().filter((e) => e.sessionId === sessionId)
  for (const entry of inFlightMatches) removeInFlight(entry.id)

  if (!existed && deleted === 0 && inFlightMatches.length === 0) {
    return false
  }

  // Destructive + irreversible (removes the session's entries, including any
  // 'failed' diagnostic rows) → log loudly so it is never an invisible cause of
  // disappearing records. Mirrors the clearHistory log.
  consola.warn(`[history] DELETED session ${sessionId} (${deleted} persisted + ${inFlightMatches.length} in-flight entries) via DELETE /api/sessions/:id`)

  historyState.publisher?.publish({ kind: "history.session_deleted", sessionId })
  historyState.publisher?.publish({ kind: "history.stats_changed", stats: computeStats() })
  return true
}
