/**
 * Memory pressure monitor — proactively evicts old history entries
 * when heap usage approaches the V8 heap limit, preventing OOM crashes.
 *
 * Graduated response:
 *   75–80%  Warning: log only, no eviction
 *   80–90%  High: evict entries, reduce maxEntries by 25%
 *   90%+    Critical: aggressive eviction, reduce maxEntries by 50%
 *
 * The monitor reduces maxEntries on each eviction event to prevent
 * re-accumulation. Reductions compound across successive events
 * (e.g. 200 → 150 → 112 → ...) until the floor is reached.
 */

import consola from "consola"

import { state } from "~/lib/state"

import { evictOldestEntries, historyState, setHistoryMaxEntries } from "./store"

// ============================================================================
// Configuration
// ============================================================================

/** Polling interval in milliseconds */
const CHECK_INTERVAL_MS = 30_000

/** Heap usage ratio thresholds */
const WARN_THRESHOLD = 0.75
const EVICT_THRESHOLD = 0.8
const CRITICAL_THRESHOLD = 0.9

/** Minimum interval between warning logs (ms) */
const WARN_LOG_COOLDOWN_MS = 300_000

// ============================================================================
// Heap limit detection
// ============================================================================

let resolvedHeapLimit: number | null = null

/**
 * Get the V8 heap size limit.
 * Falls back to a conservative 512MB for non-V8 runtimes (e.g. Bun).
 */
async function resolveHeapLimit(): Promise<number> {
  if (resolvedHeapLimit !== null) return resolvedHeapLimit

  try {
    const v8 = await import("node:v8")
    resolvedHeapLimit = v8.getHeapStatistics().heap_size_limit
  } catch {
    // Bun or other runtime without V8 internals
    resolvedHeapLimit = 512 * 1024 * 1024
  }

  return resolvedHeapLimit
}

// ============================================================================
// Module state
// ============================================================================

let timer: ReturnType<typeof setInterval> | null = null
let lastWarningTime = 0
let totalEvictedCount = 0

// ============================================================================
// Formatting helpers
// ============================================================================

function formatMB(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

// ============================================================================
// Monitor logic
// ============================================================================

async function checkMemoryPressure(): Promise<void> {
  const heapLimit = await resolveHeapLimit()
  const { heapUsed } = process.memoryUsage()
  const ratio = heapUsed / heapLimit

  // Below warning threshold — all clear
  if (ratio < WARN_THRESHOLD) return

  const currentEntries = historyState.entries.length

  // Nothing to evict — only warn if pressure is severe
  if (currentEntries <= state.historyMinEntries) {
    if (ratio >= EVICT_THRESHOLD && Date.now() - lastWarningTime > WARN_LOG_COOLDOWN_MS) {
      lastWarningTime = Date.now()
      consola.warn(
        `[memory] Heap ${formatMB(heapUsed)}/${formatMB(heapLimit)} (${formatPct(ratio)}) — `
          + `only ${currentEntries} history entries remain. `
          + `Consider increasing --max-old-space-size`,
      )
    }
    return
  }

  // Warning zone (75–80%): log warning, no eviction
  if (ratio < EVICT_THRESHOLD) {
    if (Date.now() - lastWarningTime > WARN_LOG_COOLDOWN_MS) {
      lastWarningTime = Date.now()
      consola.warn(
        `[memory] Heap ${formatMB(heapUsed)}/${formatMB(heapLimit)} (${formatPct(ratio)}) — `
          + `approaching limit, ${currentEntries} history entries in memory`,
      )
    }
    return
  }

  // ── Eviction zone (80%+) ──

  lastWarningTime = Date.now()

  // Compute new maxEntries based on current max (compounds across events)
  const currentMax = historyState.maxEntries > 0 ? historyState.maxEntries : currentEntries
  let newMaxEntries: number

  if (ratio >= CRITICAL_THRESHOLD) {
    // Critical (90%+): halve the limit
    newMaxEntries = Math.max(state.historyMinEntries, Math.floor(currentMax * 0.5))
  } else {
    // High (80–90%): reduce by 25%
    newMaxEntries = Math.max(state.historyMinEntries, Math.floor(currentMax * 0.75))
  }

  const evictCount = Math.max(0, currentEntries - newMaxEntries)
  if (evictCount <= 0) return

  const evicted = evictOldestEntries(evictCount)
  totalEvictedCount += evicted

  if (newMaxEntries < (historyState.maxEntries > 0 ? historyState.maxEntries : Infinity)) {
    setHistoryMaxEntries(newMaxEntries)
  }

  const afterHeapUsed = process.memoryUsage().heapUsed

  consola.warn(
    `[memory] Evicted ${evicted} history entries due to memory pressure `
      + `(heap: ${formatMB(heapUsed)} → ${formatMB(afterHeapUsed)}/${formatMB(heapLimit)}, `
      + `entries: ${currentEntries} → ${currentEntries - evicted}, `
      + `max: ${newMaxEntries}). `
      + `Consider increasing --max-old-space-size or reducing history_limit in config.yaml`,
  )

  // Hint GC if exposed via --expose-gc (no-op otherwise)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).gc?.()
}

// ============================================================================
// Public API
// ============================================================================

/** Start the memory pressure monitor (idempotent) */
export function startMemoryPressureMonitor(): void {
  if (timer) return

  timer = setInterval(() => {
    checkMemoryPressure().catch((error: unknown) => {
      consola.error("[memory] Error in memory pressure check:", error)
    })
  }, CHECK_INTERVAL_MS)

  // Don't prevent process exit
  if ("unref" in timer) {
    timer.unref()
  }
}

/** Stop the memory pressure monitor */
export function stopMemoryPressureMonitor(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Get memory pressure diagnostics */
export function getMemoryPressureStats(): {
  totalEvictedCount: number
  currentMaxEntries: number
  heapUsedMB: number
  heapLimitMB: number | null
} {
  const { heapUsed } = process.memoryUsage()
  return {
    totalEvictedCount,
    currentMaxEntries: historyState.maxEntries,
    heapUsedMB: Math.round(heapUsed / 1024 / 1024),
    heapLimitMB: resolvedHeapLimit ? Math.round(resolvedHeapLimit / 1024 / 1024) : null,
  }
}
