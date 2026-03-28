import type { SummaryResult, HistoryEntry, HistoryStats, SessionResult, QueryOptions } from "@/types"

const BASE = "/history/api"

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "Unknown error")
    throw new ApiError(res.status, `${res.status}: ${body}`)
  }
  return res.json()
}

/** Fetch from non-history API routes (e.g. /api/status, /models) */
async function requestRoot<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "Unknown error")
    throw new ApiError(res.status, `${res.status}: ${body}`)
  }
  return res.json()
}

export const api = {
  // Entries (cursor-based pagination)
  async fetchEntries(options: QueryOptions = {}): Promise<SummaryResult> {
    const params = new URLSearchParams()
    if (options.cursor) params.set("cursor", options.cursor)
    if (options.limit) params.set("limit", String(options.limit))
    if (options.direction) params.set("direction", options.direction)
    if (options.model) params.set("model", options.model)
    if (options.endpoint) params.set("endpoint", options.endpoint)
    if (options.success !== undefined) params.set("success", String(options.success))
    if (options.from) params.set("from", String(options.from))
    if (options.to) params.set("to", String(options.to))
    if (options.search) params.set("search", options.search)
    if (options.sessionId) params.set("sessionId", options.sessionId)
    const qs = params.toString()
    return request<SummaryResult>("/entries" + (qs ? "?" + qs : ""))
  },

  async fetchEntry(id: string): Promise<HistoryEntry> {
    return request<HistoryEntry>("/entries/" + id)
  },

  async deleteEntries(): Promise<void> {
    await request("/entries", { method: "DELETE" })
  },

  // Sessions
  async fetchSessions(): Promise<SessionResult> {
    return request<SessionResult>("/sessions")
  },

  async fetchSession(id: string): Promise<ReturnType<typeof request>> {
    return request("/sessions/" + id)
  },

  async deleteSession(id: string): Promise<void> {
    await request("/sessions/" + id, { method: "DELETE" })
  },

  // Stats & Export
  async fetchStats(): Promise<HistoryStats> {
    return request<HistoryStats>("/stats")
  },

  getExportUrl(format: "json" | "csv"): string {
    return BASE + "/export?format=" + format
  },

  // --- New endpoints for pages ---

  /** Fetch server status (dashboard) */
  async fetchStatus(): Promise<Record<string, unknown>> {
    return requestRoot<Record<string, unknown>>("/api/status")
  },

  /** Fetch server config (dashboard) */
  async fetchConfig(): Promise<Record<string, unknown>> {
    return requestRoot<Record<string, unknown>>("/api/config")
  },

  /** Fetch logs (compact view) */
  async fetchLogs(limit = 100): Promise<{ entries: Array<EntrySummary> }> {
    return request<{ entries: Array<EntrySummary> }>(`/entries?limit=${String(limit)}`)
  },

  /** Fetch models with detail */
  async fetchModels(detail = false): Promise<{ data: Array<Record<string, unknown>> }> {
    const qs = detail ? "?detail=true" : ""
    return requestRoot<{ data: Array<Record<string, unknown>> }>("/models" + qs)
  },
}

// Re-export for convenience
export type { ApiError }
// Re-export the SummaryResult type used in the store
import type { EntrySummary } from "@/types"

export { type EntrySummary } from "@/types"
