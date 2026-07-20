/**
 * Pure parser for the `/api/status` `requestTelemetry` payload.
 *
 * Extracted from `useDashboardStatus` so consumers (the Dashboard, the Models
 * page) can build a `RequestTelemetrySnapshot` from a one-shot `fetchStatus`
 * without pulling in the dashboard's WebSocket lifecycle. Behavior is byte
 * equivalent to the previous inline computed (covered by telemetry-parse tests).
 */

export interface TelemetryUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
}

export interface RequestTelemetryModelStats {
  model: string
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  averageDurationMs: number
  usage: TelemetryUsage
}

export interface RequestTelemetryModelBucket {
  timestamp: number
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  averageDurationMs: number
  usage: TelemetryUsage
}

export interface RequestTelemetryBucket {
  timestamp: number
  count: number
}

export interface RequestTelemetrySnapshot {
  acceptedSinceStart: number
  bucketSizeMinutes: number
  windowDays: number
  totalLast7d: number
  buckets: Array<RequestTelemetryBucket>
  modelsSinceStart: Array<RequestTelemetryModelStats>
  modelsLast7d: Array<RequestTelemetryModelStats & { buckets: Array<RequestTelemetryModelBucket> }>
}

const num = (v: unknown, d = 0): number => (typeof v === "number" ? v : d)

const asRecords = (v: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(v) ? v : []).filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")

function parseUsage(rawValue: unknown): TelemetryUsage {
  const usage = (rawValue && typeof rawValue === "object" ? rawValue : {}) as Record<string, unknown>
  return {
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    totalTokens: num(usage.totalTokens),
    cacheReadInputTokens: num(usage.cacheReadInputTokens),
    cacheCreationInputTokens: num(usage.cacheCreationInputTokens),
    reasoningTokens: num(usage.reasoningTokens),
  }
}

function parseModelStats(entry: Record<string, unknown>): RequestTelemetryModelStats {
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

  const buckets = asRecords(source.buckets).map((bucket) => ({ timestamp: num(bucket.timestamp), count: num(bucket.count) }))
  const modelsSinceStart = asRecords(source.modelsSinceStart).map((entry) => parseModelStats(entry))
  const modelsLast7d = asRecords(source.modelsLast7d).map((entry) => ({
    ...parseModelStats(entry),
    buckets: asRecords(entry.buckets).map((bucket) => ({
      timestamp: num(bucket.timestamp),
      requestCount: num(bucket.requestCount),
      successCount: num(bucket.successCount),
      failureCount: num(bucket.failureCount),
      totalDurationMs: num(bucket.totalDurationMs),
      averageDurationMs: num(bucket.averageDurationMs),
      usage: parseUsage(bucket.usage),
    })),
  }))

  return {
    acceptedSinceStart: num(source.acceptedSinceStart),
    bucketSizeMinutes: num(source.bucketSizeMinutes, 5),
    windowDays: num(source.windowDays, 7),
    totalLast7d: num(source.totalLast7d),
    buckets,
    modelsSinceStart,
    modelsLast7d,
  }
}
