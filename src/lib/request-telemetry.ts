import consola from "consola"
import fs from "node:fs/promises"

import type { UsageData } from "./history/store"

import {
  //
  atomicWriteJson,
  createSerializedAsyncFn,
} from "./atomic-fs"
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

/**
 * Persistence is serialized via `createSerializedAsyncFn` (see ./atomic-fs):
 * concurrent callers (periodic timer + shutdown + ad-hoc flush) take turns so
 * a younger snapshot can never lose to an older one's late rename. Combined
 * with `atomicWriteJson`, this closes both partial-write and racing-snapshot
 * failure modes that would otherwise wipe the 7-day telemetry history (the
 * loader's `catch{}` silently zeroes on corrupt JSON).
 */

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

function getOrCreateModelStats(target: Map<string, MutableModelTelemetry>, model: string): MutableModelTelemetry {
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

function buildModelSnapshots(source: Iterable<[string, MutableModelTelemetry]>): Array<RequestTelemetryModelSnapshot> {
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

function loadModelBuckets(
  // Runtime JSON: values may be null/non-objects despite the optimistic type.
  raw: Record<string, Record<string, PersistedModelTelemetry> | null | undefined>,
): void {
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
      // eslint-disable-next-line unicorn/prefer-native-coercion-functions -- type predicate narrows (X | null)[] → X[]; replacing with Boolean drops the narrowing and breaks the Map<> constructor signature
      .filter((entry): entry is readonly [number, Map<string, MutableModelTelemetry>] => Boolean(entry)),
  )
}

export async function initRequestTelemetry(): Promise<void> {
  stopPeriodicPersistence()
  acceptedSinceStart = 0
  bucketCounts = new Map()
  modelStatsSinceStart = new Map()
  modelBucketStats = new Map()

  let raw: string
  try {
    raw = await fs.readFile(telemetryFilePath, "utf8")
  } catch {
    // Missing file is non-critical; start fresh.
    pruneBuckets()
    startPeriodicPersistence()
    return
  }

  // Cast to Partial<> because JSON.parse output is unknown shape; the
  // defensive `truthy && typeof === "object"` guards below validate runtime
  // structure rather than rely on the asserted type.
  let parsed: Partial<RequestTelemetryFile>
  try {
    parsed = JSON.parse(raw) as Partial<RequestTelemetryFile>
  } catch (err) {
    // Corrupted JSON: surface the loss and quarantine the file for postmortem
    // instead of silently restarting from zero. Most common historical cause:
    // two concurrent writers interleaving O_TRUNC writes (now prevented by the
    // serialized atomic-write path below — but old corrupted files can still
    // exist from prior versions).
    consola.warn(`[telemetry] resetting 7-day usage history: telemetry file is corrupted (${err instanceof Error ? err.message : String(err)})`)
    const quarantine = `${telemetryFilePath}.corrupted.${Date.now()}`
    try {
      await fs.rename(telemetryFilePath, quarantine)
      consola.warn(`[telemetry] quarantined corrupted file → ${quarantine}`)
    } catch {
      // Rename may fail (permissions, file already gone) — non-fatal.
    }
    pruneBuckets()
    startPeriodicPersistence()
    return
  }

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

/**
 * Debounce for persist-failure logging: warn once, then stay quiet until a
 * successful write recovers. Periodic persistence runs every ~60s, so a
 * sustained failure (ENOSPC / permissions) would otherwise spam one warn per
 * minute. The asymmetry with the loader (which warns on corrupt files) is the
 * gap this closes — a write failure silently drops the 7-day history on restart.
 */
let persistFailureLogged = false

const persistTelemetrySerialized = createSerializedAsyncFn(async () => {
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
    await atomicWriteJson(telemetryFilePath, file)
    persistFailureLogged = false
  } catch (err) {
    if (!persistFailureLogged) {
      persistFailureLogged = true
      consola.warn(`[telemetry] persist failed (7-day usage history may be stale on restart):`, err)
    }
  }
})

export function persistRequestTelemetry(): Promise<void> {
  return persistTelemetrySerialized()
}

export async function shutdownRequestTelemetry(): Promise<void> {
  stopPeriodicPersistence()
  // The serialized chain inside persistTelemetrySerialized guarantees this
  // shutdown-fired persist runs AFTER any timer-fired persist already in
  // flight (or queued just before stopPeriodicPersistence cleared the timer).
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
