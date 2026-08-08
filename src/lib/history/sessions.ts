import type {
  //
  CursorResult,
  EntrySummary,
  EndpointType,
  HistoryEntry,
  SessionSummary,
} from "./types"

import { getDatabase } from "./sqlite/connection"
import { recordToHistoryEntry } from "./v3/projection"
import {
  //
  getV3StoredOperations,
  visitV3StoredOperations,
  visitV3Summaries,
} from "./v3/store"
import {
  //
  querySessionEntryPage,
  querySessionSummaries,
  withValidatedSummarySnapshot,
} from "./v3/summary-store"

/** Per-session aggregate projected exclusively from terminal V3 generation records. */
export function getSessionSummaries(limit = 200): Array<SessionSummary> {
  const db = getDatabase()
  const snapshot = withValidatedSummarySnapshot(db, () => querySessionSummaries(db, limit))
  if (snapshot.ready) return snapshot.value

  const grouped = new Map<string, Array<EntrySummary>>()
  visitV3Summaries((summary) => {
    if (!summary.sessionId) return
    const group = grouped.get(summary.sessionId) ?? []
    group.push(summary)
    grouped.set(summary.sessionId, group)
  }, "generation")

  return [...grouped.entries()]
    .map(([sessionId, sessionEntries]) => {
      sessionEntries.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
      const models = new Set<string>()
      let inputTokens = 0
      let outputTokens = 0
      let completed = 0
      let failed = 0
      let aborted = 0
      const agents = new Set<string>()
      for (const entry of sessionEntries) {
        if (entry.agentId) agents.add(entry.agentId)
        const usage = entry.usage
        inputTokens += (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0)
        outputTokens += usage?.output_tokens ?? 0
        const model = entry.responseModel ?? entry.requestModel
        if (model) models.add(model)
        switch (entry.state) {
          case "completed": {
            completed++
            break
          }
          case "failed": {
            failed++
            break
          }
          case "aborted":
          case "interrupted": {
            aborted++
            break
          }
          default: {
            break
          }
        }
      }
      const first = sessionEntries[0]
      // Group construction guarantees at least one entry.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const last = sessionEntries.at(-1)!
      return {
        sessionId,
        requestCount: sessionEntries.length,
        agentCount: agents.size,
        inputTokens,
        outputTokens,
        firstStartedAt: first.startedAt,
        lastStartedAt: last.startedAt,
        completed,
        failed,
        aborted,
        models: [...models],
        firstPreview: first.previewText,
        preview: last.previewText,
      }
    })
    .sort((a, b) => b.lastStartedAt - a.lastStartedAt || b.sessionId.localeCompare(a.sessionId))
    .slice(0, Math.max(0, limit))
}

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

/**
 * Claude Code tags each subagent request with `x-claude-code-agent-id` (a stable
 * per-subagent id); the main agent sends NO such header. So `undefined` here means
 * the main agent — telemetry keys its agentKind dimension on this (undefined → "main").
 */
export function getAgentIdFromHeaders(headers: Headers | Record<string, string | undefined>): string | undefined {
  const value = headers instanceof Headers ? headers.get("x-claude-code-agent-id") : headers["x-claude-code-agent-id"]
  return normalizeSessionId(value)
}

/**
 * Return the normalized session id when the caller has a real session identifier.
 *
 * Returns undefined when no trustworthy identifier is available. Session views are
 * derived on read from committed V3 terminal records (grouped by sessionId), so no
 * eager session-map tracking is necessary here.
 */
export function getCurrentSession(_endpoint: EndpointType, sessionId?: string): string | undefined {
  return normalizeSessionId(sessionId)
}

export function getSessionEntries(sessionId: string, options: { cursor?: string; limit?: number } = {}): CursorResult<HistoryEntry> {
  const { cursor, limit = 50 } = options
  const db = getDatabase()
  const snapshot = withValidatedSummarySnapshot(db, () => querySessionEntryPage(db, sessionId, cursor, limit))
  if (snapshot.ready) {
    const page = snapshot.value
    const stored = getV3StoredOperations(page.operationIds, db)
    const entries = page.operationIds.map((operationId) => {
      const operation = stored.get(operationId)
      if (!operation) throw new Error(`Summary projection references missing canonical operation: ${operationId}`)
      return recordToHistoryEntry(operation.record, operation)
    })
    return { entries, total: page.total, nextCursor: page.nextCursor, prevCursor: page.prevCursor }
  }

  const all: Array<HistoryEntry> = []
  visitV3StoredOperations((stored) => {
    if (stored.record.identity.sessionId === sessionId) all.push(recordToHistoryEntry(stored.record, stored))
  }, "generation")
  all.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))

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
