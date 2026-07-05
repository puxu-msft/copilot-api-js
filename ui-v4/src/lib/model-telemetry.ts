/**
 * Model telemetry: parse the /api/status requestTelemetry payload + join it onto
 * the model catalog by normalized id.
 *
 * The telemetry `model` key is split (see docs/spec/2026-07-05-ui-v4-models-enhancement.md
 * §4.2): the success leg keys on the upstream canonical name (normalized), the
 * failure leg on the verbatim client alias. We normalize BOTH sides with
 * normalizeModelId and aggregate rows that collapse to the same key. Telemetry
 * matching no catalog id is surfaced in `unmatched`, never dropped (richest-data-flow).
 */

import type { Model } from "~backend/lib/models/client"

import { normalizeModelId } from "~backend/lib/models/normalize-id"

export interface TelemetryUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
}

export interface ModelTelemetryStats {
  model: string
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  averageDurationMs: number
  usage: TelemetryUsage
}

export interface RequestTelemetrySnapshot {
  modelsSinceStart: Array<ModelTelemetryStats>
  modelsLast7d: Array<ModelTelemetryStats>
}

export interface JoinedModelTelemetry {
  last7d: ModelTelemetryStats | null
  sinceStart: ModelTelemetryStats | null
}

export interface UnmatchedTelemetryRow {
  /** First-seen original (un-normalized) telemetry key, for display. */
  model: string
  normalizedKey: string
  last7d: ModelTelemetryStats | null
  sinceStart: ModelTelemetryStats | null
}

export interface ModelTelemetryIndex {
  /** Keyed by normalizeModelId(model.id); look up via the same normalization. */
  byId: Map<string, JoinedModelTelemetry>
  unmatched: Array<UnmatchedTelemetryRow>
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0)

const asRecords = (v: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(v) ? v : []).filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")

function parseUsage(raw: unknown): TelemetryUsage {
  const u = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    totalTokens: num(u.totalTokens),
    cacheReadInputTokens: num(u.cacheReadInputTokens),
    cacheCreationInputTokens: num(u.cacheCreationInputTokens),
    reasoningTokens: num(u.reasoningTokens),
  }
}

function parseStats(entry: Record<string, unknown>): ModelTelemetryStats {
  return {
    model: typeof entry.model === "string" ? entry.model : "unknown",
    requestCount: num(entry.requestCount),
    successCount: num(entry.successCount),
    failureCount: num(entry.failureCount),
    totalDurationMs: num(entry.totalDurationMs),
    averageDurationMs: num(entry.averageDurationMs),
    usage: parseUsage(entry.usage),
  }
}

/** Parse the raw `status.requestTelemetry` object into a typed snapshot, or null when absent. */
export function parseRequestTelemetry(raw: unknown): RequestTelemetrySnapshot | null {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null
  if (!source) return null
  return {
    modelsSinceStart: asRecords(source.modelsSinceStart).map((e) => parseStats(e)),
    modelsLast7d: asRecords(source.modelsLast7d).map((e) => parseStats(e)),
  }
}

/** Sum two model-stats rows; recompute averageDurationMs from the summed totals. */
function mergeStats(a: ModelTelemetryStats, b: ModelTelemetryStats): ModelTelemetryStats {
  const requestCount = a.requestCount + b.requestCount
  const totalDurationMs = a.totalDurationMs + b.totalDurationMs
  return {
    model: a.model,
    requestCount,
    successCount: a.successCount + b.successCount,
    failureCount: a.failureCount + b.failureCount,
    totalDurationMs,
    averageDurationMs: requestCount > 0 ? totalDurationMs / requestCount : 0,
    usage: {
      inputTokens: a.usage.inputTokens + b.usage.inputTokens,
      outputTokens: a.usage.outputTokens + b.usage.outputTokens,
      totalTokens: a.usage.totalTokens + b.usage.totalTokens,
      cacheReadInputTokens: a.usage.cacheReadInputTokens + b.usage.cacheReadInputTokens,
      cacheCreationInputTokens: a.usage.cacheCreationInputTokens + b.usage.cacheCreationInputTokens,
      reasoningTokens: a.usage.reasoningTokens + b.usage.reasoningTokens,
    },
  }
}

/** Aggregate rows by normalizeModelId(row.model); first-seen original key kept for display. */
function aggregateByNormalizedKey(rows: Array<ModelTelemetryStats>): Map<string, ModelTelemetryStats> {
  const out = new Map<string, ModelTelemetryStats>()
  for (const row of rows) {
    const key = normalizeModelId(row.model)
    const prev = out.get(key)
    out.set(key, prev ? mergeStats(prev, row) : row)
  }
  return out
}

export function buildModelTelemetryIndex(snapshot: RequestTelemetrySnapshot | null, models: Array<Model>): ModelTelemetryIndex {
  const byId = new Map<string, JoinedModelTelemetry>()
  const unmatched: Array<UnmatchedTelemetryRow> = []
  if (!snapshot) return { byId, unmatched }

  const last7d = aggregateByNormalizedKey(snapshot.modelsLast7d)
  const sinceStart = aggregateByNormalizedKey(snapshot.modelsSinceStart)
  const catalogKeys = new Set(models.map((m) => normalizeModelId(m.id)))

  for (const key of new Set<string>([...last7d.keys(), ...sinceStart.keys()])) {
    const l = last7d.get(key) ?? null
    const s = sinceStart.get(key) ?? null
    if (catalogKeys.has(key)) {
      byId.set(key, { last7d: l, sinceStart: s })
    } else {
      unmatched.push({ model: l?.model ?? s?.model ?? key, normalizedKey: key, last7d: l, sinceStart: s })
    }
  }
  unmatched.sort((a, b) => a.normalizedKey.localeCompare(b.normalizedKey))
  return { byId, unmatched }
}

/** Look up joined telemetry for a catalog model id (normalizes the id). */
export function telemetryForId(index: ModelTelemetryIndex, id: string): JoinedModelTelemetry | null {
  return index.byId.get(normalizeModelId(id)) ?? null
}
