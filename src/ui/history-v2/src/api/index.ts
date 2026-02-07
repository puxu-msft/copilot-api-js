import type {
  HistoryEntry,
  HistoryResult,
  HistoryStats,
  QueryOptions,
  Session,
  SessionResult
} from '@/types'

const API_BASE = '/history/api'

export async function fetchEntries(options: QueryOptions = {}): Promise<HistoryResult> {
  const params = new URLSearchParams()
  if (options.page) params.set('page', String(options.page))
  if (options.limit) params.set('limit', String(options.limit))
  if (options.sessionId) params.set('sessionId', options.sessionId)
  if (options.endpoint) params.set('endpoint', options.endpoint)
  if (options.success !== undefined) params.set('success', String(options.success))
  if (options.search) params.set('search', options.search)
  if (options.from) params.set('from', String(options.from))
  if (options.to) params.set('to', String(options.to))
  if (options.model) params.set('model', options.model)

  const response = await fetch(`${API_BASE}/entries?${params}`)
  if (!response.ok) throw new Error(`Failed to fetch entries: ${response.statusText}`)
  return response.json()
}

export async function fetchEntry(id: string): Promise<HistoryEntry> {
  const response = await fetch(`${API_BASE}/entries/${id}`)
  if (!response.ok) throw new Error(`Failed to fetch entry: ${response.statusText}`)
  return response.json()
}

export async function deleteEntries(): Promise<void> {
  const response = await fetch(`${API_BASE}/entries`, { method: 'DELETE' })
  if (!response.ok) throw new Error(`Failed to delete entries: ${response.statusText}`)
}

export async function fetchStats(): Promise<HistoryStats> {
  const response = await fetch(`${API_BASE}/stats`)
  if (!response.ok) throw new Error(`Failed to fetch stats: ${response.statusText}`)
  return response.json()
}

export async function fetchSessions(): Promise<SessionResult> {
  const response = await fetch(`${API_BASE}/sessions`)
  if (!response.ok) throw new Error(`Failed to fetch sessions: ${response.statusText}`)
  return response.json()
}

export async function fetchSession(id: string): Promise<Session> {
  const response = await fetch(`${API_BASE}/sessions/${id}`)
  if (!response.ok) throw new Error(`Failed to fetch session: ${response.statusText}`)
  return response.json()
}

export async function deleteSession(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(`Failed to delete session: ${response.statusText}`)
}

export function getExportUrl(format: 'json' | 'csv'): string {
  return `${API_BASE}/export?format=${format}`
}

// WebSocket connection
export function createWebSocket(): WebSocket | null {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${window.location.host}/history/ws`

  try {
    return new WebSocket(wsUrl)
  } catch {
    console.warn('WebSocket connection failed')
    return null
  }
}
