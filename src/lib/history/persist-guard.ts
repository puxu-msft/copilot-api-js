/**
 * Guarded history persistence — replaces the blind `try { … } catch { warn }`
 * that wrapped every SQLite write in the history store.
 *
 * The old pattern downgraded EVERY persistence failure (FK violation, SQLITE_BUSY
 * under WAL contention, a serialization bug, disk full) to a single
 * `consola.warn` and continued as if nothing happened. The failures were real
 * and recurring in production (observed: repeated `FOREIGN KEY constraint failed`
 * on stage inserts) but invisible — no level distinction, no metric, no signal
 * that the caller could act on.
 *
 * `runHistoryWrite` instead:
 *   - classifies the error as transient (retryable later) vs permanent,
 *   - logs at ERROR (not warn) so it surfaces in the file sink / console / the
 *     canonical `system.diagnostic` event,
 *   - bumps a per-`stage:class` counter (queryable via
 *     `getHistoryPersistErrorStats`) so failures are countable, and
 *   - returns the outcome so the caller can decide whether to retain-and-retry
 *     (finalize) or treat the write as a best-effort optimization (eager/stage).
 */

import consola from "consola"

/**
 * SQLite error codes that are TRANSIENT — a later retry (e.g. on the next reaper
 * tick, once WAL contention clears) can succeed. BUSY/LOCKED are lock contention;
 * IOERR is often a transient disk/FS hiccup; PROTOCOL is a WAL-handshake race.
 */
const TRANSIENT_CODES = new Set([
  //
  "SQLITE_BUSY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_BUSY_RECOVERY",
  "SQLITE_LOCKED",
  "SQLITE_LOCKED_SHAREDCACHE",
  "SQLITE_IOERR",
  "SQLITE_PROTOCOL",
])

/** Message fragments for the same transient classes (bun:sqlite / node:sqlite do not always set `.code`). */
const TRANSIENT_MESSAGE_RE = /database is locked|database table is locked|database is busy|disk i\/o error/i

/**
 * Classify a thrown persistence error. Transient → safe to retry later; permanent
 * (constraint violation, TOOBIG, serialization bug) → retrying is pointless, the
 * caller should degrade gracefully instead.
 */
export function isTransientSqliteError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  if (typeof code === "string") {
    // Some drivers append a sub-code (e.g. "SQLITE_IOERR_WRITE"); match by prefix.
    for (const transient of TRANSIENT_CODES) if (code === transient || code.startsWith(`${transient}_`)) return true
  }
  return TRANSIENT_MESSAGE_RE.test(err.message)
}

/** Outcome of a guarded write: `ok` true on success; on failure, `transient` tells the caller whether a retry could help. */
export interface PersistResult {
  ok: boolean
  transient: boolean
}

// Per-`stage:class` failure counts. Bounded (a handful of stage names × 2
// classes). Exposed for observability/tests; not auto-wired into /api/status to
// avoid speculative surface — a status field can read this getter when wanted.
const persistErrorCounts = new Map<string, number>()

/** Snapshot of history persistence-error counts, keyed `"<stage>:<transient|permanent>"`. */
export function getHistoryPersistErrorStats(): Record<string, number> {
  return Object.fromEntries(persistErrorCounts)
}

/** Reset the persistence-error counters (test isolation). */
export function resetHistoryPersistErrorStats(): void {
  persistErrorCounts.clear()
}

/**
 * Run a history SQLite write, never throwing. On failure: classify, ERROR-log,
 * count, and return `{ ok: false, transient }` so the caller decides the fallback.
 */
export function runHistoryWrite(stage: string, fn: () => void): PersistResult {
  try {
    fn()
    return { ok: true, transient: false }
  } catch (err: unknown) {
    return recordWriteFailure(stage, err)
  }
}

/**
 * Async twin of {@link runHistoryWrite} for the offloaded finalize path
 * (`insertCompletedEntry` is async — it compresses on the libuv threadpool
 * before its synchronous tx). Same classify/log/count/never-throw contract.
 */
export async function runHistoryWriteAsync(stage: string, fn: () => Promise<void>): Promise<PersistResult> {
  try {
    await fn()
    return { ok: true, transient: false }
  } catch (err: unknown) {
    return recordWriteFailure(stage, err)
  }
}

/** Shared failure path: classify, ERROR-log, count, return the outcome. */
function recordWriteFailure(stage: string, err: unknown): PersistResult {
  const transient = isTransientSqliteError(err)
  const key = `${stage}:${transient ? "transient" : "permanent"}`
  persistErrorCounts.set(key, (persistErrorCounts.get(key) ?? 0) + 1)
  consola.error(`[history] ${stage} persist failed (${transient ? "transient" : "permanent"})`, err)
  return { ok: false, transient }
}
