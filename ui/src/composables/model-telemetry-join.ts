/**
 * Join `/api/status` model-dimension telemetry onto the model catalog.
 *
 * The telemetry `model` key is split (see spec §4.2): the success leg keys on
 * the upstream canonical name (`model.resolved` / `attempts[final].upstreamResponse.model`,
 * normalized), while the failure leg keys on the verbatim client alias
 * (`model.requested`). To
 * reunite them we normalize BOTH sides with `normalizeModelId` and aggregate
 * rows that collapse to the same key. Telemetry that matches no catalog id is
 * surfaced in `unmatched` rather than silently dropped (richest-data-flow).
 */

import type { Model } from "~backend/lib/models/client"

import { normalizeModelId } from "~backend/lib/models/normalize-id"

import type {
  //
  RequestTelemetryModelStats,
  RequestTelemetrySnapshot,
} from "./telemetry-parse"

export interface JoinedModelTelemetry {
  last7d: RequestTelemetryModelStats | null
  sinceStart: RequestTelemetryModelStats | null
}

export interface UnmatchedTelemetryRow {
  /** First-seen original (un-normalized) telemetry key, for display. */
  model: string
  normalizedKey: string
  last7d: RequestTelemetryModelStats | null
  sinceStart: RequestTelemetryModelStats | null
}

export interface ModelTelemetryIndex {
  /** Keyed by `normalizeModelId(model.id)`; look up via the same normalization. */
  byId: Map<string, JoinedModelTelemetry>
  unmatched: Array<UnmatchedTelemetryRow>
}

/** Sum two model-stats rows; recompute averageDurationMs from the summed totals. */
function mergeStats(a: RequestTelemetryModelStats, b: RequestTelemetryModelStats): RequestTelemetryModelStats {
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

/**
 * Aggregate raw telemetry rows by `normalizeModelId(row.model)`. Keeps the
 * first-seen original model string as the representative label (for unmatched
 * display).
 */
function aggregateByNormalizedKey(rows: Array<RequestTelemetryModelStats>): Map<string, RequestTelemetryModelStats> {
  const out = new Map<string, RequestTelemetryModelStats>()
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

  const allKeys = new Set<string>([...last7d.keys(), ...sinceStart.keys()])
  for (const key of allKeys) {
    const l = last7d.get(key) ?? null
    const s = sinceStart.get(key) ?? null
    if (catalogKeys.has(key)) {
      byId.set(key, { last7d: l, sinceStart: s })
    } else {
      // key came from one of the two maps, so at least one of l/s is non-null.
      unmatched.push({ model: l?.model ?? s?.model ?? key, normalizedKey: key, last7d: l, sinceStart: s })
    }
  }
  // Stable ordering for deterministic rendering/tests.
  unmatched.sort((a, b) => a.normalizedKey.localeCompare(b.normalizedKey))
  return { byId, unmatched }
}
