import type {
  //
  CursorResult,
  EndpointType,
  HistoryEntry,
  SessionSummary,
} from "./types"

import { resolveResponseUsage } from "./entry-view"
import { recordToHistoryEntry } from "./v3/projection"
import { listV3StoredOperations } from "./v3/store"

function userPreview(entry: HistoryEntry, edge: "first" | "last"): string {
  const messages = entry.clientRequest?.messages ?? []
  const ordered = edge === "first" ? messages : [...messages].reverse()
  for (const message of ordered) {
    if (message.role !== "user") continue
    const text =
      typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.map((block) => (block?.type === "text" ? block.text : "")).join(" ")
      : ""
    let cleaned = text
    for (let previous = ""; previous !== cleaned; ) {
      previous = cleaned
      cleaned = cleaned.replaceAll(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replaceAll(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, "")
    }
    cleaned = cleaned
      .replaceAll(/The TodoWrite tool hasn't been used[\s\S]*/g, "")
      .replaceAll(/The following skills are available[\s\S]*/g, "")
      .trim()
    if (cleaned) return cleaned.slice(0, 100)
  }
  return ""
}

/** Per-session aggregate projected exclusively from terminal V3 generation records. */
export function getSessionSummaries(limit = 200): Array<SessionSummary> {
  const entries = listV3StoredOperations("generation", 1_000_000).map((stored) => recordToHistoryEntry(stored.record, stored))
  const grouped = new Map<string, HistoryEntry[]>()
  for (const entry of entries) {
    if (!entry.sessionId) continue
    const group = grouped.get(entry.sessionId) ?? []
    group.push(entry)
    grouped.set(entry.sessionId, group)
  }

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
        const usage = resolveResponseUsage(entry)
        inputTokens += (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0)
        outputTokens += usage?.output_tokens ?? 0
        const model = entry.attempts?.at(-1)?.upstreamResponse?.model ?? entry.model?.resolved ?? entry.model?.requested
        if (model) models.add(model)
        if (entry.state === "completed") completed++
        else if (entry.state === "failed") failed++
        else if (entry.state === "aborted" || entry.state === "interrupted") aborted++
      }
      const first = sessionEntries[0]
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
        firstPreview: userPreview(first, "first"),
        preview: userPreview(last, "last"),
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
 * Returns undefined when no trustworthy identifier is available. The SQLite
 * session row is created on entry completion by `insertCompletedEntry`, so no
 * eager session-map tracking is necessary here.
 */
export function getCurrentSession(_endpoint: EndpointType, sessionId?: string): string | undefined {
  return normalizeSessionId(sessionId)
}

export function getSessionEntries(sessionId: string, options: { cursor?: string; limit?: number } = {}): CursorResult<HistoryEntry> {
  const { cursor, limit = 50 } = options
  const all = listV3StoredOperations("generation", 1_000_000)
    .filter(({ record }) => record.identity.sessionId === sessionId)
    .map((stored) => recordToHistoryEntry(stored.record, stored))
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))

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
