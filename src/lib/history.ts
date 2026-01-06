// History recording module for API requests/responses

// Simple ID generator (no external deps)
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
}

export interface HistoryEntry {
  id: string
  timestamp: number
  endpoint: "anthropic" | "openai"

  request: {
    model: string
    messageCount: number
    stream: boolean
    hasTools: boolean
    toolCount?: number
    max_tokens?: number
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
    contentSummary: string
    toolCalls?: string[]
  }

  durationMs?: number
}

export interface HistoryState {
  enabled: boolean
  entries: HistoryEntry[]
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
}

export interface HistoryResult {
  entries: HistoryEntry[]
  total: number
  page: number
  limit: number
  totalPages: number
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
}

// Global history state
export const historyState: HistoryState = {
  enabled: false,
  entries: [],
  maxEntries: 1000,
}

export function initHistory(enabled: boolean, maxEntries: number): void {
  historyState.enabled = enabled
  historyState.maxEntries = maxEntries
  historyState.entries = []
}

export function isHistoryEnabled(): boolean {
  return historyState.enabled
}

export function recordRequest(
  endpoint: "anthropic" | "openai",
  request: HistoryEntry["request"],
): string {
  if (!historyState.enabled) {
    return ""
  }

  const entry: HistoryEntry = {
    id: generateId(),
    timestamp: Date.now(),
    endpoint,
    request,
  }

  historyState.entries.push(entry)

  // Enforce max entries limit (FIFO)
  while (historyState.entries.length > historyState.maxEntries) {
    historyState.entries.shift()
  }

  return entry.id
}

export function recordResponse(
  id: string,
  response: HistoryEntry["response"],
  durationMs: number,
): void {
  if (!historyState.enabled || !id) {
    return
  }

  const entry = historyState.entries.find((e) => e.id === id)
  if (entry) {
    entry.response = response
    entry.durationMs = durationMs
  }
}

export function getHistory(options: QueryOptions = {}): HistoryResult {
  const {
    page = 1,
    limit = 50,
    model,
    endpoint,
    success,
    from,
    to,
    search,
  } = options

  let filtered = [...historyState.entries]

  // Apply filters
  if (model) {
    filtered = filtered.filter(
      (e) =>
        e.request.model.toLowerCase().includes(model.toLowerCase())
        || e.response?.model.toLowerCase().includes(model.toLowerCase()),
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
    filtered = filtered.filter(
      (e) =>
        e.response?.contentSummary?.toLowerCase().includes(searchLower)
        || e.response?.toolCalls?.some((t) =>
          t.toLowerCase().includes(searchLower),
        ),
    )
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

export function clearHistory(): void {
  historyState.entries = []
}

export function getStats(): HistoryStats {
  const entries = historyState.entries
  const completed = entries.filter((e) => e.response)

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
    const model = entry.response?.model || entry.request.model
    modelDist[model] = (modelDist[model] || 0) + 1

    // Endpoint distribution
    endpointDist[entry.endpoint] = (endpointDist[entry.endpoint] || 0) + 1

    // Hourly activity (last 24 hours)
    const hour = new Date(entry.timestamp).toISOString().slice(0, 13)
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
  }
}

export function exportHistory(
  format: "json" | "csv" = "json",
): string {
  if (format === "json") {
    return JSON.stringify(historyState.entries, null, 2)
  }

  // CSV format
  const headers = [
    "id",
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
    new Date(e.timestamp).toISOString(),
    e.endpoint,
    e.request.model,
    e.request.messageCount,
    e.request.stream,
    e.response?.success ?? "",
    e.response?.model ?? "",
    e.response?.usage.input_tokens ?? "",
    e.response?.usage.output_tokens ?? "",
    e.durationMs ?? "",
    e.response?.stop_reason ?? "",
    e.response?.error ?? "",
  ])

  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n")
}
