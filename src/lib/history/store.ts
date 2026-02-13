/**
 * History recording module for API requests/responses.
 * Supports full message content, session grouping, and rich querying.
 */

import { generateId } from "../utils"
import { notifyEntryAdded, notifyEntryUpdated } from "./ws"

// Format timestamp as local ISO-like string (YYYY-MM-DD HH:MM:SS)
function formatLocalTimestamp(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  const h = String(d.getHours()).padStart(2, "0")
  const m = String(d.getMinutes()).padStart(2, "0")
  const s = String(d.getSeconds()).padStart(2, "0")
  return `${y}-${mo}-${day} ${h}:${m}:${s}`
}

/** Message types for full content storage */
export interface MessageContent {
  role: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: string | Array<any> | null
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

export interface ToolDefinition {
  name: string
  description?: string
}

export interface TruncationInfo {
  /** Number of messages removed from the beginning of the conversation */
  removedMessageCount: number
  /** Estimated token count before truncation */
  originalTokens: number
  /** Estimated token count after truncation */
  compactedTokens: number
  /** Processing time in milliseconds */
  processingTimeMs: number
}

export interface SanitizationInfo {
  /** Number of orphaned tool blocks/messages removed */
  removedBlockCount: number
  /** Number of system-reminder tags removed */
  systemReminderRemovals: number
}

export interface RewriteInfo {
  /** Auto-truncation metadata */
  truncation?: TruncationInfo
  /** Sanitization metadata */
  sanitization?: SanitizationInfo
  /** Rewritten messages as actually sent to the API */
  rewrittenMessages?: Array<MessageContent>
  /** Rewritten system prompt (if modified) */
  rewrittenSystem?: string
  /** Rewritten→original message index mapping: messageMapping[rwIdx] = origIdx */
  messageMapping?: Array<number>
}

export interface HistoryEntry {
  id: string
  sessionId: string // Group related requests together
  timestamp: number
  endpoint: "anthropic" | "openai"

  request: {
    model?: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages?: Array<MessageContent> // Full message history
    stream?: boolean
    tools?: Array<ToolDefinition>
    max_tokens?: number
    temperature?: number
    system?: string | Array<{ type: "text"; text: string; cache_control?: { type: string } | null }>
  }

  response?: {
    success: boolean
    model: string
    usage: {
      input_tokens: number
      output_tokens: number
      cache_read_input_tokens?: number
    }
    stop_reason?: string
    error?: string
    content: MessageContent | null // Full response content
  }

  /** Auto-truncation metadata (set when messages were truncated before sending to API) */
  truncation?: TruncationInfo

  /** All rewrite metadata (truncation + sanitization + rewritten content) */
  rewrites?: RewriteInfo

  durationMs?: number
}

export interface Session {
  id: string
  startTime: number
  lastActivity: number
  requestCount: number
  totalInputTokens: number
  totalOutputTokens: number
  models: Array<string>
  endpoint: "anthropic" | "openai"
  toolsUsed?: Array<string> // Tool names used in this session
}

export interface HistoryState {
  enabled: boolean
  entries: Array<HistoryEntry>
  sessions: Map<string, Session>
  currentSessionId: string
  maxEntries: number
}

export interface QueryOptions {
  page?: number
  limit?: number
  model?: string
  endpoint?: "anthropic" | "openai"
  success?: boolean
  from?: number
  to?: number
  search?: string
  sessionId?: string
}

export interface HistoryResult {
  entries: Array<HistoryEntry>
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface SessionResult {
  sessions: Array<Session>
  total: number
}

export interface HistoryStats {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  averageDurationMs: number
  modelDistribution: Record<string, number>
  endpointDistribution: Record<string, number>
  recentActivity: Array<{ hour: string; count: number }>
  activeSessions: number
}

/** Global history state */
export const historyState: HistoryState = {
  enabled: false,
  entries: [],
  sessions: new Map(),
  currentSessionId: "",
  maxEntries: 200,
}

export function initHistory(enabled: boolean, maxEntries: number): void {
  historyState.enabled = enabled
  historyState.maxEntries = maxEntries
  historyState.entries = []
  historyState.sessions = new Map()
  historyState.currentSessionId = enabled ? generateId() : ""
}

export function isHistoryEnabled(): boolean {
  return historyState.enabled
}

/**
 * Get or create current session.
 * Currently treats all requests as belonging to one session per server lifetime,
 * since clients don't provide session identifiers yet.
 * TODO: When clients support session headers, use that to group requests.
 */
function getCurrentSession(endpoint: "anthropic" | "openai"): string {
  if (historyState.currentSessionId) {
    const session = historyState.sessions.get(historyState.currentSessionId)
    if (session) {
      session.lastActivity = Date.now()
      return historyState.currentSessionId
    }
  }

  // Create initial session
  const now = Date.now()
  const sessionId = generateId()
  historyState.currentSessionId = sessionId
  historyState.sessions.set(sessionId, {
    id: sessionId,
    startTime: now,
    lastActivity: now,
    requestCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    models: [],
    endpoint,
  })

  return sessionId
}

export interface RecordRequestParams {
  model: string
  messages: Array<MessageContent>
  stream: boolean
  tools?: Array<ToolDefinition>
  max_tokens?: number
  temperature?: number
  system?: string | Array<{ type: "text"; text: string; cache_control?: { type: string } | null }>
}

export function recordRequest(endpoint: "anthropic" | "openai", request: RecordRequestParams): string {
  if (!historyState.enabled) {
    return ""
  }

  const sessionId = getCurrentSession(endpoint)
  const session = historyState.sessions.get(sessionId)
  if (!session) {
    return ""
  }

  const entry: HistoryEntry = {
    id: generateId(),
    sessionId,
    timestamp: Date.now(),
    endpoint,
    request: {
      model: request.model,
      messages: request.messages,
      stream: request.stream,
      tools: request.tools,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      system: request.system,
    },
  }

  historyState.entries.push(entry)
  session.requestCount++

  if (!session.models.includes(request.model)) {
    session.models.push(request.model)
  }

  // Track tools used
  if (request.tools && request.tools.length > 0) {
    if (!session.toolsUsed) {
      session.toolsUsed = []
    }
    for (const tool of request.tools) {
      if (!session.toolsUsed.includes(tool.name)) {
        session.toolsUsed.push(tool.name)
      }
    }
  }

  // Enforce max entries limit (FIFO), skip if maxEntries is 0 (unlimited)
  while (historyState.maxEntries > 0 && historyState.entries.length > historyState.maxEntries) {
    const removed = historyState.entries.shift()
    // Clean up empty sessions
    if (removed) {
      const sessionEntries = historyState.entries.filter((e) => e.sessionId === removed.sessionId)
      if (sessionEntries.length === 0) {
        historyState.sessions.delete(removed.sessionId)
      }
    }
  }

  // Notify WebSocket clients
  notifyEntryAdded(entry)

  return entry.id
}

export interface RecordResponseParams {
  success: boolean
  model: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
  }
  stop_reason?: string
  error?: string
  content: MessageContent | null
}

export function recordResponse(id: string, response: RecordResponseParams, durationMs: number): void {
  if (!historyState.enabled || !id) {
    return
  }

  const entry = historyState.entries.find((e) => e.id === id)
  if (entry) {
    entry.response = response
    entry.durationMs = durationMs

    // Update session stats
    const session = historyState.sessions.get(entry.sessionId)
    if (session) {
      session.totalInputTokens += response.usage.input_tokens
      session.totalOutputTokens += response.usage.output_tokens
      session.lastActivity = Date.now()
    }

    // Notify WebSocket clients
    notifyEntryUpdated(entry)
  }
}

export function recordTruncation(id: string, truncation: TruncationInfo): void {
  if (!historyState.enabled || !id) {
    return
  }

  const entry = historyState.entries.find((e) => e.id === id)
  if (entry) {
    entry.truncation = truncation
    notifyEntryUpdated(entry)
  }
}

export function recordRewrites(id: string, rewrites: RewriteInfo): void {
  if (!historyState.enabled || !id) {
    return
  }

  const entry = historyState.entries.find((e) => e.id === id)
  if (entry) {
    entry.rewrites = rewrites
    // Also keep truncation for backward compatibility
    if (rewrites.truncation) {
      entry.truncation = rewrites.truncation
    }
    notifyEntryUpdated(entry)
  }
}

export function getHistory(options: QueryOptions = {}): HistoryResult {
  const { page = 1, limit = 50, model, endpoint, success, from, to, search, sessionId } = options

  let filtered = [...historyState.entries]

  // Apply filters
  if (sessionId) {
    filtered = filtered.filter((e) => e.sessionId === sessionId)
  }

  if (model) {
    const modelLower = model.toLowerCase()
    filtered = filtered.filter(
      (e) => e.request.model?.toLowerCase().includes(modelLower) || e.response?.model.toLowerCase().includes(modelLower),
    )
  }

  if (endpoint) {
    filtered = filtered.filter((e) => e.endpoint === endpoint)
  }

  if (success !== undefined) {
    filtered = filtered.filter((e) => e.response?.success === success)
  }

  if (from) {
    filtered = filtered.filter((e) => e.timestamp >= from)
  }

  if (to) {
    filtered = filtered.filter((e) => e.timestamp <= to)
  }

  if (search) {
    const searchLower = search.toLowerCase()
    filtered = filtered.filter((e) => {
      // Search in model name
      if (
        e.request.model?.toLowerCase().includes(searchLower)
        || (e.response?.model && e.response.model.toLowerCase().includes(searchLower))
      ) {
        return true
      }

      // Search in error message
      if (e.response?.error && e.response.error.toLowerCase().includes(searchLower)) return true

      // Search in system prompt
      if (e.request.system) {
        if (typeof e.request.system === "string") {
          if (e.request.system.toLowerCase().includes(searchLower)) return true
        } else {
          if (e.request.system.some((b) => b.text.toLowerCase().includes(searchLower))) return true
        }
      }

      // Search in messages (text, tool_use name/input, tool_result content)
      const msgMatch = e.request.messages?.some((m) => {
        if (typeof m.content === "string") {
          return m.content.toLowerCase().includes(searchLower)
        }
        if (Array.isArray(m.content)) {
          return m.content.some((c) => {
            if (c.text && c.text.toLowerCase().includes(searchLower)) return true
            if (c.type === "tool_use") {
              const name = c.name as string | undefined
              if (name && name.toLowerCase().includes(searchLower)) return true
              if (c.input) {
                const inputStr = typeof c.input === "string" ? c.input : JSON.stringify(c.input)
                if (inputStr.toLowerCase().includes(searchLower)) return true
              }
            }
            if (c.type === "tool_result" && c.content) {
              const contentStr = typeof c.content === "string" ? c.content : JSON.stringify(c.content)
              if (contentStr.toLowerCase().includes(searchLower)) return true
            }
            if (c.type === "thinking") {
              const thinking = c.thinking as string | undefined
              if (thinking && thinking.toLowerCase().includes(searchLower)) return true
            }
            return false
          })
        }
        return false
      })
      if (msgMatch) return true

      // Search in response content (both string and array forms)
      if (e.response?.content) {
        const rc = e.response.content
        if (typeof rc.content === "string" && rc.content.toLowerCase().includes(searchLower)) return true
        if (Array.isArray(rc.content)) {
          const rcMatch = rc.content.some((c: { type?: string; text?: string; name?: string; thinking?: string }) => {
            if (c.text && c.text.toLowerCase().includes(searchLower)) return true
            if (c.type === "tool_use" && c.name && c.name.toLowerCase().includes(searchLower)) return true
            if (c.type === "thinking" && c.thinking && c.thinking.toLowerCase().includes(searchLower)) return true
            return false
          })
          if (rcMatch) return true
        }
      }

      return false
    })
  }

  // Sort by timestamp descending (newest first)
  filtered.sort((a, b) => b.timestamp - a.timestamp)

  const total = filtered.length
  const totalPages = Math.ceil(total / limit)
  const start = (page - 1) * limit
  const entries = filtered.slice(start, start + limit)

  return {
    entries,
    total,
    page,
    limit,
    totalPages,
  }
}

export function getEntry(id: string): HistoryEntry | undefined {
  return historyState.entries.find((e) => e.id === id)
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

export function getSessionEntries(sessionId: string): Array<HistoryEntry> {
  return historyState.entries.filter((e) => e.sessionId === sessionId).sort((a, b) => a.timestamp - b.timestamp) // Chronological order for sessions
}

export function clearHistory(): void {
  historyState.entries = []
  historyState.sessions = new Map()
  historyState.currentSessionId = generateId()
}

export function deleteSession(sessionId: string): boolean {
  if (!historyState.sessions.has(sessionId)) {
    return false
  }

  historyState.entries = historyState.entries.filter((e) => e.sessionId !== sessionId)
  historyState.sessions.delete(sessionId)

  if (historyState.currentSessionId === sessionId) {
    historyState.currentSessionId = generateId()
  }

  return true
}

export function getStats(): HistoryStats {
  const entries = historyState.entries

  const modelDist: Record<string, number> = {}
  const endpointDist: Record<string, number> = {}
  const hourlyActivity: Record<string, number> = {}

  let totalInput = 0
  let totalOutput = 0
  let totalDuration = 0
  let durationCount = 0
  let successCount = 0
  let failCount = 0

  for (const entry of entries) {
    // Model distribution
    const model = entry.response?.model || entry.request.model || "unknown"
    modelDist[model] = (modelDist[model] || 0) + 1

    // Endpoint distribution
    endpointDist[entry.endpoint] = (endpointDist[entry.endpoint] || 0) + 1

    // Hourly activity (last 24 hours) - use local time
    const d = new Date(entry.timestamp)
    const y = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    const h = String(d.getHours()).padStart(2, "0")
    const hour = `${y}-${mo}-${day}T${h}`
    hourlyActivity[hour] = (hourlyActivity[hour] || 0) + 1

    if (entry.response) {
      if (entry.response.success === true) {
        successCount++
      } else if (entry.response.success === false) {
        failCount++
      }
      // When success is undefined (e.g. streaming in progress), neither count is incremented

      totalInput += entry.response.usage.input_tokens
      totalOutput += entry.response.usage.output_tokens
    }

    if (entry.durationMs) {
      totalDuration += entry.durationMs
      durationCount++
    }
  }

  // Convert hourly activity to sorted array (last 24 entries)
  const recentActivity = Object.entries(hourlyActivity)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-24)
    .map(([hour, count]) => ({ hour, count }))

  return {
    totalRequests: entries.length,
    successfulRequests: successCount,
    failedRequests: failCount,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    averageDurationMs: durationCount > 0 ? totalDuration / durationCount : 0,
    modelDistribution: modelDist,
    endpointDistribution: endpointDist,
    recentActivity,
    activeSessions: historyState.sessions.size,
  }
}

export function exportHistory(format: "json" | "csv" = "json"): string {
  if (format === "json") {
    return JSON.stringify(
      {
        sessions: Array.from(historyState.sessions.values()),
        entries: historyState.entries,
      },
      null,
      2,
    )
  }

  // CSV format - simplified view
  const headers = [
    "id",
    "session_id",
    "timestamp",
    "endpoint",
    "request_model",
    "message_count",
    "stream",
    "success",
    "response_model",
    "input_tokens",
    "output_tokens",
    "duration_ms",
    "stop_reason",
    "error",
  ]

  const rows = historyState.entries.map((e) => [
    e.id,
    e.sessionId,
    formatLocalTimestamp(e.timestamp),
    e.endpoint,
    e.request.model,
    e.request.messages?.length,
    e.request.stream,
    e.response?.success,
    e.response?.model,
    e.response?.usage.input_tokens,
    e.response?.usage.output_tokens,
    e.durationMs,
    e.response?.stop_reason,
    e.response?.error,
  ])

  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n")
}
