import type { EntrySummary } from "@/types"

export interface RequestFilters {
  search: string
  model: string
  endpoint: string | null
  state: string | null
  pid: number | null
  sessionId: string | null
  from: number | null
  to: number | null
}

export type ChipKey = keyof RequestFilters

/** Terminal lifecycle states — the only ones the History list (terminalOnly) shows. */
export const TERMINAL_STATES = ["completed", "failed", "aborted", "interrupted"] as const

export const EMPTY_FILTERS: RequestFilters = {
  search: "",
  model: "",
  endpoint: null,
  state: null,
  pid: null,
  sessionId: null,
  from: null,
  to: null,
}

export function parseFilters(sp: URLSearchParams): RequestFilters {
  const num = (v: string | null): number | null => {
    if (v === null || v.trim() === "") return null
    const n = Number.parseInt(v, 10)
    return Number.isNaN(n) ? null : n
  }
  return {
    search: sp.get("search") ?? "",
    model: sp.get("model") ?? "",
    endpoint: sp.get("endpoint") || null,
    state: sp.get("state") || null,
    pid: num(sp.get("pid")),
    sessionId: sp.get("sessionId") || null,
    from: num(sp.get("from")),
    to: num(sp.get("to")),
  }
}

export function serializeFilters(f: RequestFilters): URLSearchParams {
  const sp = new URLSearchParams()
  if (f.search) sp.set("search", f.search)
  if (f.model) sp.set("model", f.model)
  if (f.endpoint) sp.set("endpoint", f.endpoint)
  if (f.state) sp.set("state", f.state)
  if (f.pid !== null) sp.set("pid", String(f.pid))
  if (f.sessionId) sp.set("sessionId", f.sessionId)
  if (f.from !== null) sp.set("from", String(f.from))
  if (f.to !== null) sp.set("to", String(f.to))
  return sp
}

export function toQueryString(f: RequestFilters): string {
  return serializeFilters(f).toString()
}

export function hasAnyFilter(f: RequestFilters): boolean {
  return (
    f.search !== "" || f.model !== "" || f.endpoint !== null || f.state !== null || f.pid !== null || f.sessionId !== null || f.from !== null || f.to !== null
  )
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function activeChips(f: RequestFilters): Array<{ key: ChipKey; label: string }> {
  const chips: Array<{ key: ChipKey; label: string }> = []
  if (f.search) chips.push({ key: "search", label: `search: ${f.search}` })
  if (f.model) chips.push({ key: "model", label: `model: ${f.model}` })
  if (f.endpoint) chips.push({ key: "endpoint", label: `endpoint: ${f.endpoint}` })
  if (f.state) chips.push({ key: "state", label: `state: ${f.state}` })
  if (f.pid !== null) chips.push({ key: "pid", label: `pid: ${f.pid}` })
  if (f.sessionId) chips.push({ key: "sessionId", label: `session: ${f.sessionId.slice(0, 12)}…` })
  if (f.from !== null || f.to !== null) {
    const lo = f.from !== null ? fmtDate(f.from) : "…"
    const hi = f.to !== null ? fmtDate(f.to) : "…"
    chips.push({ key: f.from !== null ? "from" : "to", label: `time: ${lo} → ${hi}` })
  }
  return chips
}

/**
 * Client-side gating for WS-arriving summaries + `?at=` membership — mirrors the
 * backend `summaryMatchesFilters` (queries.ts): sessionId/endpoint/from/to/model/
 * state/pid. The `search` dimension is DELIBERATELY excluded (backend gates search
 * as full-text for in-flight and preview_text LIKE for persisted; a preview
 * substring here would diverge). search filtering happens only at the SQL layer.
 */
export function matchesGating(e: EntrySummary, f: RequestFilters): boolean {
  if (f.sessionId && e.sessionId !== f.sessionId) return false
  if (f.endpoint && e.endpoint !== f.endpoint) return false
  if (f.from !== null && e.startedAt < f.from) return false
  if (f.to !== null && e.startedAt > f.to) return false
  if (f.model) {
    const needle = f.model.toLowerCase()
    const req = e.requestModel?.toLowerCase() ?? ""
    const res = e.responseModel?.toLowerCase() ?? ""
    if (!req.includes(needle) && !res.includes(needle)) return false
  }
  if (f.state && e.state !== f.state) return false
  if (f.pid !== null && e.pid !== f.pid) return false
  return true
}
