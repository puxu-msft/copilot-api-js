/**
 * History recording module for API requests/responses.
 * Supports full message content, session grouping, and rich querying.
 */

import { generateId } from "../utils"
import {
  notifyEntryAdded,
  notifyEntryUpdated,
  notifyHistoryCleared,
  notifySessionDeleted,
  notifyStatsUpdated,
} from "./ws"

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

/** Supported API endpoint types */
export type EndpointType = "anthropic-messages" | "openai-chat-completions" | "openai-responses"

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

// ============================================================================
// Content block types — Anthropic API content block variants
// ============================================================================

export interface TextContentBlock {
  type: "text"
  text: string
}

export interface ThinkingContentBlock {
  type: "thinking"
  thinking: string
  signature?: string
}

export interface ToolUseContentBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

/** Text block within a tool_result content array */
export interface ToolResultTextBlock {
  type: "text"
  text: string
}

/** Image block within a tool_result content array */
export interface ToolResultImageBlock {
  type: "image"
  source: ImageSource
}

export interface ToolResultContentBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<ToolResultTextBlock | ToolResultImageBlock>
  is_error?: boolean
}

export type ImageSource =
  | {
      type: "base64"
      media_type: string
      data: string
    }
  | {
      type: "url"
      url: string
    }

export interface ImageContentBlock {
  type: "image"
  source: ImageSource
}

export interface ServerToolUseContentBlock {
  type: "server_tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface RedactedThinkingContentBlock {
  type: "redacted_thinking"
  data?: string
}

export interface WebSearchToolResultContentBlock {
  type: "web_search_tool_result"
  tool_use_id: string
  content: unknown
}

/**
 * Generic server-side tool result block (tool_search_tool_result,
 * code_execution_tool_result, etc.). Covers all *_tool_result types
 * not explicitly typed above.
 */
export interface ServerToolResultContentBlock {
  type: string
  tool_use_id: string
  content: unknown
}

/** Union of all content block types that can appear in messages */
export type ContentBlock =
  | TextContentBlock
  | ThinkingContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ImageContentBlock
  | ServerToolUseContentBlock
  | RedactedThinkingContentBlock
  | WebSearchToolResultContentBlock
  | ServerToolResultContentBlock

export interface ToolDefinition {
  name: string
  description?: string
  type?: string
  input_schema?: Record<string, unknown>
  [key: string]: unknown
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
  /** Total content blocks removed */
  totalBlocksRemoved: number
  /** Number of orphaned tool_use blocks removed */
  orphanedToolUseCount: number
  /** Number of orphaned tool_result blocks removed */
  orphanedToolResultCount: number
  /** Number of tool_use names fixed (casing) */
  fixedNameCount: number
  /** Number of empty text blocks removed */
  emptyTextBlocksRemoved: number
  /** Number of system-reminder tags removed */
  systemReminderRemovals: number
}

export interface PreprocessInfo {
  /** Number of system-reminder tags stripped from Read tool results */
  strippedReadTagCount: number
  /** Number of duplicate tool_use/tool_result pairs deduplicated */
  dedupedToolCallCount: number
}

/** A single SSE event captured from an Anthropic streaming response */
export interface SseEventRecord {
  /** Milliseconds since request start */
  offsetMs: number
  /** SSE event type (e.g. "message_start", "content_block_start") */
  type: string
  /** Raw event data (the parsed JSON payload) */
  data: unknown
}

export interface RewriteInfo {
  /** Auto-truncation metadata */
  truncation?: TruncationInfo
  /** Phase 1 preprocessing metadata (idempotent, run once before routing) */
  preprocessing?: PreprocessInfo
  /** Phase 2 sanitization metadata (repeatable, one entry per attempt) */
  sanitization?: Array<SanitizationInfo>
  /** Rewritten messages as actually sent to the API */
  rewrittenMessages?: Array<MessageContent>
  /** Rewritten system prompt (if modified) */
  rewrittenSystem?: string
  /** Rewritten→original message index mapping: messageMapping[rwIdx] = origIdx */
  messageMapping?: Array<number>
}

export interface UsageData {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface SystemBlock {
  type: "text"
  text: string
  cache_control?: { type: string } | null
}

export interface HistoryEntry {
  id: string
  sessionId: string // Group related requests together
  timestamp: number
  endpoint: EndpointType

  request: {
    model?: string
    messages?: Array<MessageContent> // Full message history
    stream?: boolean
    tools?: Array<ToolDefinition>
    max_tokens?: number
    temperature?: number
    system?: string | Array<SystemBlock>
  }

  response?: {
    success: boolean
    model: string
    usage: UsageData
    stop_reason?: string
    error?: string
    content: MessageContent | null // Full response content
  }

  /** All rewrite metadata (truncation + sanitization + rewritten content) */
  rewrites?: RewriteInfo

  /** Filtered SSE events from Anthropic streaming (excludes content_block_delta and ping) */
  sseEvents?: Array<SseEventRecord>

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
  /** Endpoint types used in this session (may include multiple if mixed) */
  endpoints: Array<EndpointType>
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
  endpoint?: EndpointType
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

// ─── Entry Summary ───

/** Lightweight projection of a HistoryEntry for list views and WebSocket broadcasts */
export interface EntrySummary {
  id: string
  sessionId: string
  timestamp: number
  endpoint: EndpointType

  requestModel?: string
  stream?: boolean
  messageCount: number

  responseModel?: string
  responseSuccess?: boolean
  responseError?: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }

  durationMs?: number
  /** First 100 characters of the last user message, for list preview */
  previewText: string
  /** Pre-computed lowercase text for search matching */
  searchText: string
}

export interface SummaryResult {
  entries: Array<EntrySummary>
  total: number
  page: number
  limit: number
  totalPages: number
}

/** Extract a preview from the last user message (first 100 chars) */
function extractPreviewText(entry: HistoryEntry): string {
  const messages = entry.request.messages
  if (!messages || messages.length === 0) return ""

  // Walk backwards to find the last user message (skip tool responses)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    // Skip OpenAI tool responses and Anthropic tool_result messages
    if (msg.role === "tool") continue
    if (msg.role !== "user") continue

    if (typeof msg.content === "string") {
      return msg.content.slice(0, 100)
    }
    if (Array.isArray(msg.content)) {
      // Anthropic-style content blocks: look for text, skip tool_result
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          return (block.text as string).slice(0, 100)
        }
        if (block.type === "tool_result") {
          // user message that only contains tool_result — skip this message entirely
          break
        }
      }
      continue // try previous messages
    }
    break
  }

  // Fallback: if the last message is an assistant with tool_calls, show tool name
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const names = msg.tool_calls.map((tc) => tc.function.name).join(", ")
      return `[tool_call: ${names}]`.slice(0, 100)
    }
    if (msg.role === "tool") {
      return `[tool_result: ${msg.tool_call_id ?? msg.name ?? "unknown"}]`.slice(0, 100)
    }
    break
  }

  return ""
}

/**
 * Build a pre-computed lowercase string for fast search matching.
 * Includes model names, error, system prompt preview, and message text snippets.
 * Deliberately kept compact — only the first ~200 chars of each message for memory efficiency.
 */
function buildSearchText(entry: HistoryEntry): string {
  const parts: Array<string> = []

  // Model names
  if (entry.request.model) parts.push(entry.request.model)
  if (entry.response?.model) parts.push(entry.response.model)

  // Error
  if (entry.response?.error) parts.push(entry.response.error)

  // System prompt (first 500 chars)
  if (entry.request.system) {
    if (typeof entry.request.system === "string") {
      parts.push(entry.request.system.slice(0, 500))
    } else {
      for (const block of entry.request.system) {
        parts.push(block.text.slice(0, 200))
      }
    }
  }

  // Message text snippets
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
      // OpenAI tool_calls
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function.name) parts.push(tc.function.name)
          if (tc.function.arguments) parts.push(tc.function.arguments.slice(0, 500))
        }
      }
    }
  }

  // Response content snippets
  if (entry.response?.content) {
    const rc = entry.response.content
    if (typeof rc.content === "string") {
      parts.push(rc.content.slice(0, 200))
    } else if (Array.isArray(rc.content)) {
      for (const block of rc.content) {
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

/** Build a summary from a full HistoryEntry (searchText is computed lazily) */
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
    // Lazy: computed on first search/history API access via ensureSearchText()
    searchText: "",
  }
}

/** Lazily compute and cache searchText for an entry */
function ensureSearchText(id: string): string {
  const summary = summaryIndex.get(id)
  if (!summary) return ""
  if (summary.searchText === "") {
    const entry = entryIndex.get(id)
    if (entry) {
      summary.searchText = buildSearchText(entry)
    }
  }
  return summary.searchText
}

/** Global history state */
export const historyState: HistoryState = {
  enabled: false,
  entries: [],
  sessions: new Map(),
  currentSessionId: "",
  maxEntries: 200,
}

/** O(1) lookup index for entries by ID */
const entryIndex = new Map<string, HistoryEntry>()

/** O(1) lookup for entry summaries by ID */
const summaryIndex = new Map<string, EntrySummary>()

/** Track entry count per session to avoid O(n) filter during FIFO eviction */
const sessionEntryCount = new Map<string, number>()

/** O(1) uniqueness tracking for session.models (avoids Array.includes in hot path) */
const sessionModelsSet = new Map<string, Set<string>>()

/** O(1) uniqueness tracking for session.toolsUsed (avoids Array.includes in hot path) */
const sessionToolsSet = new Map<string, Set<string>>()

/** Dirty flag for stats cache — set true when entries are inserted/updated */
let statsDirty = true

/** Cached stats result — recomputed only when statsDirty is true */
let cachedStats: HistoryStats | null = null

export function initHistory(enabled: boolean, maxEntries: number): void {
  historyState.enabled = enabled
  historyState.maxEntries = maxEntries
  historyState.entries = []
  historyState.sessions = new Map()
  historyState.currentSessionId = enabled ? generateId() : ""
  entryIndex.clear()
  summaryIndex.clear()
  sessionEntryCount.clear()
  sessionModelsSet.clear()
  sessionToolsSet.clear()
  statsDirty = true
  cachedStats = null
}

/** Update the maximum number of history entries (for config hot-reload) */
export function setHistoryMaxEntries(limit: number): void {
  historyState.maxEntries = limit
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
export function getCurrentSession(endpoint: EndpointType): string {
  if (historyState.currentSessionId) {
    const session = historyState.sessions.get(historyState.currentSessionId)
    if (session) {
      session.lastActivity = Date.now()
      // Track all endpoint types used in this session
      if (!session.endpoints.includes(endpoint)) {
        session.endpoints.push(endpoint)
      }
      return historyState.currentSessionId
    }
  }

  // Create initial session
  const now = Date.now()
  const sessionId = generateId()
  historyState.currentSessionId = sessionId
  sessionModelsSet.set(sessionId, new Set())
  sessionToolsSet.set(sessionId, new Set())
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

// ─── Context-driven API ───

/**
 * Insert a pre-built history entry.
 * Used by the context consumer — the entry already has an ID and sessionId.
 */
export function insertEntry(entry: HistoryEntry): void {
  if (!historyState.enabled) return

  const session = historyState.sessions.get(entry.sessionId)
  if (!session) return

  historyState.entries.push(entry)
  entryIndex.set(entry.id, entry)
  session.requestCount++
  sessionEntryCount.set(entry.sessionId, (sessionEntryCount.get(entry.sessionId) ?? 0) + 1)

  // Track model (O(1) via Set)
  const model = entry.request.model
  if (model) {
    const modelsSet = sessionModelsSet.get(entry.sessionId)
    if (modelsSet && !modelsSet.has(model)) {
      modelsSet.add(model)
      session.models.push(model)
    }
  }

  // Track tools (O(1) via Set)
  if (entry.request.tools && entry.request.tools.length > 0) {
    if (!session.toolsUsed) {
      session.toolsUsed = []
    }
    let toolsSet = sessionToolsSet.get(entry.sessionId)
    if (!toolsSet) {
      toolsSet = new Set(session.toolsUsed)
      sessionToolsSet.set(entry.sessionId, toolsSet)
    }
    for (const tool of entry.request.tools) {
      if (!toolsSet.has(tool.name)) {
        toolsSet.add(tool.name)
        session.toolsUsed.push(tool.name)
      }
    }
  }

  // Build and cache summary
  const summary = toSummary(entry)
  summaryIndex.set(entry.id, summary)

  // FIFO eviction (splice instead of repeated shift for O(1) amortized)
  if (historyState.maxEntries > 0 && historyState.entries.length > historyState.maxEntries) {
    const excess = historyState.entries.length - historyState.maxEntries
    const removed = historyState.entries.splice(0, excess)
    for (const r of removed) {
      entryIndex.delete(r.id)
      summaryIndex.delete(r.id)
      const count = (sessionEntryCount.get(r.sessionId) ?? 1) - 1
      if (count <= 0) {
        sessionEntryCount.delete(r.sessionId)
        sessionModelsSet.delete(r.sessionId)
        sessionToolsSet.delete(r.sessionId)
        historyState.sessions.delete(r.sessionId)
      } else {
        sessionEntryCount.set(r.sessionId, count)
      }
    }
  }

  statsDirty = true
  notifyEntryAdded(summary)
  notifyStatsUpdated(getStats())
}

/**
 * Update an existing entry's response, rewrites, or duration.
 * Used by the context consumer on completion/failure events.
 */
export function updateEntry(
  id: string,
  update: Partial<Pick<HistoryEntry, "request" | "response" | "rewrites" | "sseEvents" | "durationMs">>,
): void {
  if (!historyState.enabled) return

  const entry = entryIndex.get(id)
  if (!entry) return

  if (update.request) {
    entry.request = update.request

    // Update session metadata that depends on request data
    const session = historyState.sessions.get(entry.sessionId)
    if (session) {
      const model = update.request.model
      if (model) {
        const modelsSet = sessionModelsSet.get(entry.sessionId)
        if (modelsSet && !modelsSet.has(model)) {
          modelsSet.add(model)
          session.models.push(model)
        }
      }
      if (update.request.tools && update.request.tools.length > 0) {
        if (!session.toolsUsed) {
          session.toolsUsed = []
        }
        let toolsSet = sessionToolsSet.get(entry.sessionId)
        if (!toolsSet) {
          toolsSet = new Set(session.toolsUsed)
          sessionToolsSet.set(entry.sessionId, toolsSet)
        }
        for (const tool of update.request.tools) {
          if (!toolsSet.has(tool.name)) {
            toolsSet.add(tool.name)
            session.toolsUsed.push(tool.name)
          }
        }
      }
    }
  }
  if (update.response) {
    entry.response = update.response
  }
  if (update.rewrites) {
    entry.rewrites = update.rewrites
  }
  if (update.durationMs !== undefined) {
    entry.durationMs = update.durationMs
  }
  if (update.sseEvents) {
    entry.sseEvents = update.sseEvents
  }

  // Update session token stats when response is set
  if (update.response) {
    const session = historyState.sessions.get(entry.sessionId)
    if (session) {
      session.totalInputTokens += update.response.usage.input_tokens
      session.totalOutputTokens += update.response.usage.output_tokens
      session.lastActivity = Date.now()
    }
  }

  // Rebuild summary cache and broadcast
  statsDirty = true
  const summary = toSummary(entry)
  summaryIndex.set(entry.id, summary)
  notifyEntryUpdated(summary)
  notifyStatsUpdated(getStats())
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
      (e) =>
        e.request.model?.toLowerCase().includes(modelLower) || e.response?.model.toLowerCase().includes(modelLower),
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
    filtered = filtered.filter((e) => ensureSearchText(e.id).includes(searchLower))
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
  return entryIndex.get(id) ?? historyState.entries.find((e) => e.id === id)
}

export function getSummary(id: string): EntrySummary | undefined {
  return summaryIndex.get(id)
}

/**
 * Efficient summary-only query for list views. Filters and paginates using
 * the lightweight summaryIndex instead of full entries.
 * Search matches against the pre-computed `searchText` field — O(n) string
 * includes instead of O(n*m*b) deep content block traversal.
 */
export function getHistorySummaries(options: QueryOptions = {}): SummaryResult {
  const { page = 1, limit = 50, model, endpoint, success, from, to, search, sessionId } = options

  let summaries = Array.from(summaryIndex.values())

  // Filter
  if (sessionId) summaries = summaries.filter((s) => s.sessionId === sessionId)
  if (model) {
    const modelLower = model.toLowerCase()
    summaries = summaries.filter(
      (s) => s.requestModel?.toLowerCase().includes(modelLower) || s.responseModel?.toLowerCase().includes(modelLower),
    )
  }
  if (endpoint) summaries = summaries.filter((s) => s.endpoint === endpoint)
  if (success !== undefined) summaries = summaries.filter((s) => s.responseSuccess === success)
  if (from) summaries = summaries.filter((s) => s.timestamp >= from)
  if (to) summaries = summaries.filter((s) => s.timestamp <= to)

  // Search against pre-computed lowercase text (lazy-computed on first access)
  if (search) {
    const needle = search.toLowerCase()
    summaries = summaries.filter((s) => {
      if (s.searchText === "") {
        const entry = entryIndex.get(s.id)
        if (entry) s.searchText = buildSearchText(entry)
      }
      return s.searchText.includes(needle)
    })
  }

  // Sort newest first
  summaries.sort((a, b) => b.timestamp - a.timestamp)

  const total = summaries.length
  const totalPages = Math.ceil(total / limit)
  const start = (page - 1) * limit
  const entries = summaries.slice(start, start + limit)

  return { entries, total, page, limit, totalPages }
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

export function getSessionEntries(sessionId: string, options: { page?: number; limit?: number } = {}): HistoryResult {
  const { page = 1, limit = 50 } = options
  const all = historyState.entries.filter((e) => e.sessionId === sessionId).sort((a, b) => a.timestamp - b.timestamp) // Chronological order for sessions

  const total = all.length
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const start = (page - 1) * limit
  const entries = all.slice(start, start + limit)

  return { entries, total, page, limit, totalPages }
}

export function clearHistory(): void {
  historyState.entries = []
  historyState.sessions = new Map()
  historyState.currentSessionId = generateId()
  entryIndex.clear()
  summaryIndex.clear()
  sessionEntryCount.clear()
  sessionModelsSet.clear()
  sessionToolsSet.clear()
  statsDirty = true
  cachedStats = null
  notifyHistoryCleared()
  notifyStatsUpdated(getStats())
}

export function deleteSession(sessionId: string): boolean {
  if (!historyState.sessions.has(sessionId)) {
    return false
  }

  const remaining: Array<HistoryEntry> = []
  for (const e of historyState.entries) {
    if (e.sessionId === sessionId) {
      entryIndex.delete(e.id)
      summaryIndex.delete(e.id)
    } else {
      remaining.push(e)
    }
  }
  historyState.entries = remaining
  historyState.sessions.delete(sessionId)
  sessionEntryCount.delete(sessionId)
  sessionModelsSet.delete(sessionId)
  sessionToolsSet.delete(sessionId)
  statsDirty = true
  cachedStats = null

  if (historyState.currentSessionId === sessionId) {
    historyState.currentSessionId = generateId()
  }

  notifySessionDeleted(sessionId)
  notifyStatsUpdated(getStats())

  return true
}

export function getStats(): HistoryStats {
  // Return cached stats if nothing has changed
  if (!statsDirty && cachedStats) return cachedStats

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
      if (entry.response.success) {
        successCount++
      } else {
        failCount++
      }

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

  const stats: HistoryStats = {
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

  statsDirty = false
  cachedStats = stats
  return stats
}

/** Escape a value for CSV: wrap in quotes if it contains comma, quote, or newline; convert nullish to empty string */
function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  const str = typeof value === "string" ? value : JSON.stringify(value)
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replaceAll('"', '""')}"`
  }
  return str
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

  return [headers.join(","), ...rows.map((r) => r.map((v) => escapeCsvValue(v)).join(","))].join("\n")
}
