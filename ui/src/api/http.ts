import type {
  //
  SummaryResult,
  DimensionBreakdownSnapshot,
  HistoryEntry,
  HistoryStats,
  QueryOptions,
  SearchResult,
  SearchSource,
} from "@/types"
import type {
  //

  ConfigYamlResponse,
  EditableConfig,
} from "@/types/config"

const BASE = "/history/api"

/** Parameters for the dedicated `/search` endpoint. */
export interface SearchParams {
  source: SearchSource
  q: string
  limit?: number
  cursor?: string
  model?: string
  endpoint?: string
  sessionId?: string
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public bodyText: string,
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
    throw new ApiError(res.status, `${res.status}: ${body}`, body)
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
    throw new ApiError(res.status, `${res.status}: ${body}`, body)
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
    if (options.state) params.set("state", options.state)
    if (options.from) params.set("from", String(options.from))
    if (options.to) params.set("to", String(options.to))
    if (options.search) params.set("search", options.search)
    if (options.sessionId) params.set("sessionId", options.sessionId)
    if (options.pid !== undefined) params.set("pid", String(options.pid))
    const qs = params.toString()
    return request<SummaryResult>("/entries" + (qs ? "?" + qs : ""))
  },

  async fetchEntry(id: string): Promise<HistoryEntry> {
    return request<HistoryEntry>("/entries/" + id)
  },

  /** Download one entry as a zstd-compressed `.json.zst` blob (binary — bypasses the JSON `request<T>` helper). */
  async fetchEntryExport(id: string): Promise<Blob> {
    const res = await fetch(BASE + "/entries/" + id + "/export")
    if (!res.ok) {
      const body = await res.text().catch(() => "Unknown error")
      throw new ApiError(res.status, `${res.status}: ${body}`, body)
    }
    return res.blob()
  },

  async deleteEntries(): Promise<void> {
    await request("/entries", { method: "DELETE" })
  },

  // Sessions
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

  // Dedicated content-addressed search (5 facets)
  async search(params: SearchParams): Promise<SearchResult> {
    const qs = new URLSearchParams()
    qs.set("source", params.source)
    qs.set("q", params.q)
    if (params.limit) qs.set("limit", String(params.limit))
    if (params.cursor) qs.set("cursor", params.cursor)
    if (params.model) qs.set("model", params.model)
    if (params.endpoint) qs.set("endpoint", params.endpoint)
    if (params.sessionId) qs.set("sessionId", params.sessionId)
    return request<SearchResult>("/search?" + qs.toString())
  },

  /** Lazy companion: every request id referencing a given message hash. */
  async searchContains(hash: string): Promise<{ hash: string; reqIds: Array<string> }> {
    return request<{ hash: string; reqIds: Array<string> }>("/search/contains?hash=" + encodeURIComponent(hash))
  },

  // --- New endpoints for pages ---

  /** Fetch server status (dashboard) */
  async fetchStatus(): Promise<Record<string, unknown>> {
    return requestRoot<Record<string, unknown>>("/api/status")
  },

  /** Fetch a per-dimension operational-stats breakdown (dashboard) */
  async fetchDimensionStats(dimension: string, window: "sinceStart" | "7d" = "7d", limit?: number): Promise<DimensionBreakdownSnapshot> {
    const params = new URLSearchParams({ dimension, window })
    if (limit) params.set("limit", String(limit))
    return requestRoot<DimensionBreakdownSnapshot>(`/api/stats?${params.toString()}`)
  },

  /** Fetch server config (dashboard) */
  async fetchConfig(): Promise<Record<string, unknown>> {
    return requestRoot<Record<string, unknown>>("/api/config")
  },

  /** Fetch editable config.yaml contents */
  async fetchConfigYaml(): Promise<ConfigYamlResponse> {
    return requestRoot<ConfigYamlResponse>("/api/config/yaml")
  },

  /** Save editable config.yaml contents */
  async saveConfigYaml(config: EditableConfig): Promise<ConfigYamlResponse> {
    return requestRoot<ConfigYamlResponse>("/api/config/yaml", {
      method: "PUT",
      body: JSON.stringify(config),
    })
  },

  /** Fetch logs (compact view) */
  async fetchLogs(limit = 100): Promise<{ entries: Array<EntrySummary> }> {
    return request<{ entries: Array<EntrySummary> }>(`/entries?limit=${String(limit)}`)
  },

  /** Fetch models using the full internal Copilot model payload. */
  async fetchModels(): Promise<{ data: Array<Record<string, unknown>> }> {
    return requestRoot<{ data: Array<Record<string, unknown>> }>("/api/models")
  },
}

// Re-export for convenience
export { ApiError }

// Re-export the SummaryResult type used in the store
import type { EntrySummary } from "@/types"

export { type EntrySummary } from "@/types"

export { type ConfigValidationError, type ConfigYamlResponse, type EditableConfig } from "@/types/config"
