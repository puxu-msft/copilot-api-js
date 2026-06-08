/** Split a HistoryEntry into SQL-indexable columns plus a gzipped JSON blob. */

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  extractPreviewText,
  extractSearchText,
} from "~/lib/history/in-flight"

import {
  //
  gunzipJson,
  gzipJson,
} from "./compression"

export interface EntryRow {
  id: string
  session_id: string | null
  started_at: number
  ended_at: number | null
  duration_ms: number | null
  model: string | null
  endpoint: string | null
  transport: string | null
  status: string
  input_tokens: number | null
  output_tokens: number | null
  cache_read: number | null
  cache_creation: number | null
  reasoning_tokens: number | null
  stop_reason: string | null
  error_message: string | null
  message_count: number | null
  preview_text: string | null
  search_text: string | null
  blob_gz: Uint8Array
}

/** HistoryEntry keys represented in dedicated row columns — excluded from blob_gz. */
const META_KEYS = new Set<string>(["id", "sessionId", "startedAt", "endedAt", "durationMs", "endpoint", "transport", "state"])

export function serializeEntry(entry: HistoryEntry): { row: EntryRow; blob: Uint8Array } {
  const usage = entry.response?.usage
  const blobPayload = extractBlobPayload(entry)
  const blob = gzipJson(blobPayload)

  const row: EntryRow = {
    id: entry.id,
    session_id: entry.sessionId ?? null,
    started_at: entry.startedAt,
    ended_at: entry.endedAt ?? null,
    duration_ms: entry.durationMs ?? null,
    model: entry.response?.model ?? entry.request.model ?? null,
    endpoint: entry.endpoint,
    transport: entry.transport ?? null,
    status: entry.state ?? "unknown",
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    cache_read: usage?.cache_read_input_tokens ?? null,
    cache_creation: usage?.cache_creation_input_tokens ?? null,
    reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
    stop_reason: entry.response?.stop_reason ?? null,
    error_message: entry.response?.error ?? null,
    message_count: entry.request.messages?.length ?? null,
    preview_text: extractPreviewText(entry),
    search_text: extractSearchText(entry),
    blob_gz: blob,
  }
  return { row, blob }
}

export function deserializeEntry(row: EntryRow, blob?: Uint8Array): HistoryEntry {
  const bytes = blob ?? row.blob_gz
  const restored = gunzipJson(bytes) as Partial<HistoryEntry>
  return {
    ...restored,
    id: row.id,
    sessionId: row.session_id ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    endpoint: (row.endpoint ?? restored.endpoint) as HistoryEntry["endpoint"],
    transport: (row.transport ?? restored.transport) as HistoryEntry["transport"],
    state: (row.status as HistoryEntry["state"]) ?? restored.state ?? "completed",
    active: false,
    lastUpdatedAt: row.ended_at ?? row.started_at,
  } as HistoryEntry
}

function extractBlobPayload(entry: HistoryEntry): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (META_KEYS.has(key)) continue
    payload[key] = value
  }
  return payload
}
