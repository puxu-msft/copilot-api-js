import fs from "node:fs/promises"

import type { UsageData } from "./history/store"

import { PATHS } from "./config/paths"

const BUCKET_MS = 5 * 60 * 1000
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const PERSIST_INTERVAL_MS = 60 * 1000

interface RequestTelemetryFileV1 {
  version: 1
  buckets: Record<string, number>
}

interface PersistedModelTelemetry {
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
}

interface RequestTelemetryFileV2 {
  version: 2
  buckets: Record<string, number>
  modelBuckets: Record<string, Record<string, PersistedModelTelemetry>>
}

type RequestTelemetryFile = RequestTelemetryFileV1 | RequestTelemetryFileV2

export interface RequestTelemetryBucket {
  timestamp: number
  count: number
}

export interface RequestTelemetryUsageTotals {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
}

export interface RequestTelemetryModelBucket {
  timestamp: number
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  averageDurationMs: number
  usage: RequestTelemetryUsageTotals
}

export interface RequestTelemetryModelSnapshot {
  model: string
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  averageDurationMs: number
  usage: RequestTelemetryUsageTotals
}

export interface RequestTelemetryModelSeriesSnapshot extends RequestTelemetryModelSnapshot {
  buckets: Array<RequestTelemetryModelBucket>
}

export interface RequestTelemetrySnapshot {
  acceptedSinceStart: number
  bucketSizeMinutes: number
  windowDays: number
  totalLast7d: number
  buckets: Array<RequestTelemetryBucket>
  modelsSinceStart: Array<RequestTelemetryModelSnapshot>
  modelsLast7d: Array<RequestTelemetryModelSeriesSnapshot>
}

interface MutableModelTelemetry {
  requestCount: number
  successCount: number
  failureCount: number
  totalDurationMs: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
}

let acceptedSinceStart = 0
let bucketCounts = new Map<number, number>()
let modelStatsSinceStart = new Map<string, MutableModelTelemetry>()
let modelBucketStats = new Map<number, Map<string, MutableModelTelemetry>>()
let persistTimer: ReturnType<typeof setInterval> | null = null
let telemetryFilePath = PATHS.REQUEST_TELEMETRY

function getBucketStart(timestamp: number): number {
  return Math.floor(timestamp / BUCKET_MS) * BUCKET_MS
}

function createEmptyModelTelemetry(): MutableModelTelemetry {
  return {
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    totalDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
  }
}

function isValidPersistedModelTelemetry(value: unknown): value is PersistedModelTelemetry {
  if (!value || typeof value !== "object") return false
  const stats = value as Record<string, unknown>
  return (
    typeof stats.requestCount === "number"
    && typeof stats.successCount === "number"
    && typeof stats.failureCount === "number"
    && typeof stats.totalDurationMs === "number"
    && typeof stats.inputTokens === "number"
    && typeof stats.outputTokens === "number"
    && typeof stats.cacheReadInputTokens === "number"
    && typeof stats.cacheCreationInputTokens === "number"
    && typeof stats.reasoningTokens === "number"
  )
}

function copyPersistedTelemetry(stats: PersistedModelTelemetry): MutableModelTelemetry {
  return {
    requestCount: stats.requestCount,
    successCount: stats.successCount,
    failureCount: stats.failureCount,
    totalDurationMs: stats.totalDurationMs,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cacheReadInputTokens: stats.cacheReadInputTokens,
    cacheCreationInputTokens: stats.cacheCreationInputTokens,
    reasoningTokens: stats.reasoningTokens,
  }
}

function getOrCreateModelStats(
  target: Map<string, MutableModelTelemetry>,
  model: string,
): MutableModelTelemetry {
  const normalizedModel = model.trim() || "unknown"
  let stats = target.get(normalizedModel)
  if (!stats) {
    stats = createEmptyModelTelemetry()
    target.set(normalizedModel, stats)
  }
  return stats
}

function getOrCreateModelBucket(timestamp: number): Map<string, MutableModelTelemetry> {
  let bucket = modelBucketStats.get(timestamp)
  if (!bucket) {
    bucket = new Map()
    modelBucketStats.set(timestamp, bucket)
  }
  return bucket
}

function applySettledTelemetry(
  stats: MutableModelTelemetry,
  opts: {
    startedAt: number
    endedAt: number
    success: boolean
    usage?: UsageData
  },
): void {
  const durationMs = Math.max(0, opts.endedAt - opts.startedAt)
  const usage = opts.usage

  stats.requestCount += 1
  if (opts.success) {
    stats.successCount += 1
  } else {
    stats.failureCount += 1
  }
  stats.totalDurationMs += durationMs
  stats.inputTokens += usage?.input_tokens ?? 0
  stats.outputTokens += usage?.output_tokens ?? 0
  stats.cacheReadInputTokens += usage?.cache_read_input_tokens ?? 0
  stats.cacheCreationInputTokens += usage?.cache_creation_input_tokens ?? 0
  stats.reasoningTokens += usage?.output_tokens_details?.reasoning_tokens ?? 0
}

function pruneBuckets(now = Date.now()): void {
  const earliest = getBucketStart(now - WINDOW_MS)
  for (const key of bucketCounts.keys()) {
    if (key < earliest) {
      bucketCounts.delete(key)
    }
  }
  for (const key of modelBucketStats.keys()) {
    if (key < earliest) {
      modelBucketStats.delete(key)
    }
  }
}

function buildFilledBuckets(now = Date.now()): Array<RequestTelemetryBucket> {
  const latestBucket = getBucketStart(now)
  const bucketCount = Math.floor(WINDOW_MS / BUCKET_MS)
  const firstBucket = latestBucket - (bucketCount - 1) * BUCKET_MS
  const result: Array<RequestTelemetryBucket> = []

  for (let index = 0; index < bucketCount; index++) {
    const timestamp = firstBucket + index * BUCKET_MS
    result.push({
      timestamp,
      count: bucketCounts.get(timestamp) ?? 0,
    })
  }

  return result
}

function buildModelSnapshots(
  source: Iterable<[string, MutableModelTelemetry]>,
): Array<RequestTelemetryModelSnapshot> {
  return [...source]
    .map(([model, stats]) => toModelSnapshot(model, stats))
    .sort(
      (left, right) =>
        right.requestCount - left.requestCount
        || right.usage.totalTokens - left.usage.totalTokens
        || right.totalDurationMs - left.totalDurationMs
        || left.model.localeCompare(right.model),
    )
}

function toUsageTotals(stats: MutableModelTelemetry): RequestTelemetryUsageTotals {
  return {
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    totalTokens: stats.inputTokens + stats.outputTokens,
    cacheReadInputTokens: stats.cacheReadInputTokens,
    cacheCreationInputTokens: stats.cacheCreationInputTokens,
    reasoningTokens: stats.reasoningTokens,
  }
}

function toModelSnapshot(model: string, stats: MutableModelTelemetry): RequestTelemetryModelSnapshot {
  return {
    model,
    requestCount: stats.requestCount,
    successCount: stats.successCount,
    failureCount: stats.failureCount,
    totalDurationMs: stats.totalDurationMs,
    averageDurationMs: stats.requestCount > 0 ? stats.totalDurationMs / stats.requestCount : 0,
    usage: toUsageTotals(stats),
  }
}

function buildLast7dModelSnapshots(now = Date.now()): Array<RequestTelemetryModelSeriesSnapshot> {
  pruneBuckets(now)
  const aggregate = new Map<string, MutableModelTelemetry>()
  const series = new Map<string, Array<RequestTelemetryModelBucket>>()

  for (const [timestamp, bucket] of modelBucketStats.entries()) {
    for (const [model, stats] of bucket.entries()) {
      const target = getOrCreateModelStats(aggregate, model)
      target.requestCount += stats.requestCount
      target.successCount += stats.successCount
      target.failureCount += stats.failureCount
      target.totalDurationMs += stats.totalDurationMs
      target.inputTokens += stats.inputTokens
      target.outputTokens += stats.outputTokens
      target.cacheReadInputTokens += stats.cacheReadInputTokens
      target.cacheCreationInputTokens += stats.cacheCreationInputTokens
      target.reasoningTokens += stats.reasoningTokens

      let buckets = series.get(model)
      if (!buckets) {
        buckets = []
        series.set(model, buckets)
      }
      buckets.push({
        timestamp,
        requestCount: stats.requestCount,
        successCount: stats.successCount,
        failureCount: stats.failureCount,
        totalDurationMs: stats.totalDurationMs,
        averageDurationMs: stats.requestCount > 0 ? stats.totalDurationMs / stats.requestCount : 0,
        usage: toUsageTotals(stats),
      })
    }
  }

  return [...aggregate.entries()]
    .map(([model, stats]) => ({
      ...toModelSnapshot(model, stats),
      buckets: (series.get(model) ?? []).sort((left, right) => left.timestamp - right.timestamp),
    }))
    .sort(
      (left, right) =>
        right.requestCount - left.requestCount
        || right.usage.totalTokens - left.usage.totalTokens
        || right.totalDurationMs - left.totalDurationMs
        || left.model.localeCompare(right.model),
    )
}

function startPeriodicPersistence(): void {
  if (persistTimer) return
  persistTimer = setInterval(() => {
    void persistRequestTelemetry()
  }, PERSIST_INTERVAL_MS)
}

function stopPeriodicPersistence(): void {
  if (!persistTimer) return
  clearInterval(persistTimer)
  persistTimer = null
}

function loadModelBuckets(raw: Record<string, Record<string, PersistedModelTelemetry>>): void {
  modelBucketStats = new Map(
    Object.entries(raw)
      .map(([bucketKey, bucketValue]) => {
        const bucketTimestamp = Number(bucketKey)
        if (!Number.isFinite(bucketTimestamp) || !bucketValue || typeof bucketValue !== "object") {
          return null
        }

        const bucket = new Map<string, MutableModelTelemetry>()
        for (const [model, stats] of Object.entries(bucketValue)) {
          if (isValidPersistedModelTelemetry(stats)) {
            bucket.set(model, copyPersistedTelemetry(stats))
          }
        }

        return [bucketTimestamp, bucket] as const
      })
      .filter((entry): entry is readonly [number, Map<string, MutableModelTelemetry>] => Boolean(entry)),
  )
}

export async function initRequestTelemetry(): Promise<void> {
  stopPeriodicPersistence()
  acceptedSinceStart = 0
  bucketCounts = new Map()
  modelStatsSinceStart = new Map()
  modelBucketStats = new Map()

  try {
    const raw = await fs.readFile(telemetryFilePath, "utf8")
    const parsed = JSON.parse(raw) as RequestTelemetryFile
    if (parsed.buckets && typeof parsed.buckets === "object") {
      bucketCounts = new Map(
        Object.entries(parsed.buckets)
          .map(([key, value]) => [Number(key), value] as const)
          .filter(([key, value]) => Number.isFinite(key) && typeof value === "number" && value >= 0),
      )
    }

    if (parsed.version === 2 && parsed.modelBuckets && typeof parsed.modelBuckets === "object") {
      loadModelBuckets(parsed.modelBuckets)
    }
  } catch {
    // Missing or malformed file is non-critical; start fresh.
  }

  pruneBuckets()
  startPeriodicPersistence()
}

export function recordAcceptedRequest(timestamp = Date.now()): void {
  acceptedSinceStart += 1
  const bucket = getBucketStart(timestamp)
  bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1)
  pruneBuckets(timestamp)
}

export function recordSettledRequest(
  model: string,
  opts: {
    startedAt: number
    endedAt: number
    success: boolean
    usage?: UsageData
  },
): void {
  const normalizedModel = model.trim() || "unknown"
  const sinceStartStats = getOrCreateModelStats(modelStatsSinceStart, normalizedModel)
  applySettledTelemetry(sinceStartStats, opts)

  const bucketTimestamp = getBucketStart(opts.startedAt)
  const bucket = getOrCreateModelBucket(bucketTimestamp)
  const bucketStats = getOrCreateModelStats(bucket, normalizedModel)
  applySettledTelemetry(bucketStats, opts)
  pruneBuckets(opts.startedAt)
}

export function getRequestTelemetrySnapshot(now = Date.now()): RequestTelemetrySnapshot {
  pruneBuckets(now)
  const buckets = buildFilledBuckets(now)
  const totalLast7d = buckets.reduce((sum, bucket) => sum + bucket.count, 0)

  return {
    acceptedSinceStart,
    bucketSizeMinutes: BUCKET_MS / (60 * 1000),
    windowDays: WINDOW_MS / (24 * 60 * 60 * 1000),
    totalLast7d,
    buckets,
    modelsSinceStart: buildModelSnapshots(modelStatsSinceStart.entries()),
    modelsLast7d: buildLast7dModelSnapshots(now),
  }
}

export async function persistRequestTelemetry(): Promise<void> {
  pruneBuckets()
  const file: RequestTelemetryFileV2 = {
    version: 2,
    buckets: Object.fromEntries([...bucketCounts.entries()].map(([key, value]) => [String(key), value])),
    modelBuckets: Object.fromEntries(
      [...modelBucketStats.entries()].map(([bucketTimestamp, bucket]) => [
        String(bucketTimestamp),
        Object.fromEntries(
          [...bucket.entries()].map(([model, stats]) => [
            model,
            {
              requestCount: stats.requestCount,
              successCount: stats.successCount,
              failureCount: stats.failureCount,
              totalDurationMs: stats.totalDurationMs,
              inputTokens: stats.inputTokens,
              outputTokens: stats.outputTokens,
              cacheReadInputTokens: stats.cacheReadInputTokens,
              cacheCreationInputTokens: stats.cacheCreationInputTokens,
              reasoningTokens: stats.reasoningTokens,
            },
          ]),
        ),
      ]),
    ),
  }
  try {
    await fs.writeFile(telemetryFilePath, JSON.stringify(file, null, 2), "utf8")
  } catch {
    // Write failure is non-critical; telemetry will continue in memory.
  }
}

export async function shutdownRequestTelemetry(): Promise<void> {
  stopPeriodicPersistence()
  await persistRequestTelemetry()
}

export function _resetRequestTelemetryForTests(): void {
  stopPeriodicPersistence()
  acceptedSinceStart = 0
  bucketCounts = new Map()
  modelStatsSinceStart = new Map()
  modelBucketStats = new Map()
  telemetryFilePath = PATHS.REQUEST_TELEMETRY
}

export function _setRequestTelemetryFilePathForTests(path: string): void {
  telemetryFilePath = path
}
