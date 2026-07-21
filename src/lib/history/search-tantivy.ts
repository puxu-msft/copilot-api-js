import type { ModelOperationRecord } from "~/lib/context/model-operation-record"

import {
  //
  getNativeHistorySearch,
  type NativeHistoryIndex,
  type TantivySearchHit,
} from "./search-native"
import { projectSearchableText } from "./v3/projection"

export interface TantivySearchStatus {
  enabled: boolean
  state: "disabled" | "initializing" | "ready" | "degraded"
  path?: string
  pendingOperations: number
  indexedOperations: number
  failedOperations: number
  /** Staged-but-not-yet-committed documents (debounce window). Diagnostic. */
  pendingUncommitted: number
  lastError?: string
}

interface TantivySearchConfig {
  enabled: boolean
  path: string
}

// Debounce/batch commit cadence. A single flush commits every document staged since
// the last commit into ONE Tantivy segment — this is what prevents the per-request
// segment explosion that blew up memory. Search results lag at most one window.
const FLUSH_IDLE_MS = 3_000
const FLUSH_MAX_OPS = 200
const FLUSH_MAX_MS = 30_000

let config: TantivySearchConfig | undefined
let generation = 0
let tail: Promise<void> = Promise.resolve()
/**
 * Memoized single index handle. A Promise (not the resolved instance) so concurrent
 * callers — a search racing an upsert — share ONE construction instead of each doing
 * `new HistoryIndex(path)` (a second live IndexWriter on the same dir → LockBusy).
 */
let instancePromise: Promise<NativeHistoryIndex> | undefined
let uncommitted = 0
let firstUncommittedAt: number | undefined
let flushTimer: ReturnType<typeof setTimeout> | undefined
let status: TantivySearchStatus = {
  enabled: false,
  state: "disabled",
  pendingOperations: 0,
  indexedOperations: 0,
  failedOperations: 0,
  pendingUncommitted: 0,
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clearFlushTimer(): void {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
}

/**
 * Lazily construct the single index handle. Construction failure (e.g. transient
 * LockBusy) clears the memo so the NEXT call retries — a stateful class must not
 * permanently degrade the way a one-shot open-per-request never could.
 */
function ensureInstance(captured: TantivySearchConfig): Promise<NativeHistoryIndex> {
  if (instancePromise) return instancePromise
  const pending = (async () => {
    const native = await getNativeHistorySearch()
    return new native.HistoryIndex(captured.path)
  })()
  instancePromise = pending
  // Side-observer reset (guarded so a concurrent reconfigure's newer memo is never
  // clobbered). Does not consume `pending` — callers still await it and see errors.
  pending.catch(() => {
    if (instancePromise === pending) instancePromise = undefined
  })
  return pending
}

/** Enqueue a commit of the CURRENT handle onto the tail, capturing it as a local
 *  (handoff invariants: flush runs serially on the tail, never on a swapped instance). */
function enqueueFlush(capturedGeneration: number): void {
  clearFlushTimer()
  if (uncommitted === 0) return
  const target = instancePromise
  uncommitted = 0
  firstUncommittedAt = undefined
  if (!target) return
  tail = tail
    .then(async () => {
      try {
        const instance = await target
        await instance.flush()
      } catch (error) {
        if (instancePromise === target) instancePromise = undefined
        if (generation === capturedGeneration) status = { ...status, state: "degraded", lastError: errorText(error) }
      }
    })
    .catch(() => undefined)
}

function scheduleFlush(capturedGeneration: number): void {
  if (uncommitted === 0) return
  const sinceFirst = firstUncommittedAt === undefined ? 0 : Date.now() - firstUncommittedAt
  if (uncommitted >= FLUSH_MAX_OPS || sinceFirst >= FLUSH_MAX_MS) {
    enqueueFlush(capturedGeneration)
    return
  }
  clearFlushTimer()
  flushTimer = setTimeout(() => enqueueFlush(capturedGeneration), FLUSH_IDLE_MS)
  flushTimer.unref()
}

/** Retire the OUTGOING handle on reconfigure/disable: synchronously clear the timer and
 *  enqueue `close()` (which commits) onto the OLD tail — debounce-window documents are
 *  committed, not dropped (Tantivy `IndexWriter::Drop` does NOT commit). */
function retireCurrentInstance(): void {
  clearFlushTimer()
  const retiring = instancePromise
  instancePromise = undefined
  uncommitted = 0
  firstUncommittedAt = undefined
  if (!retiring) return
  tail = tail
    .then(async () => {
      try {
        const instance = await retiring
        await instance.close()
      } catch {
        // Construction never succeeded, or close failed — nothing recoverable to flush.
      }
    })
    .catch(() => undefined)
}

export function configureTantivySearch(next: TantivySearchConfig): void {
  retireCurrentInstance()
  const previousTail = tail
  generation++
  config = next.enabled ? { ...next } : undefined
  status = {
    enabled: next.enabled,
    state: next.enabled ? "initializing" : "disabled",
    ...(next.enabled ? { path: next.path } : {}),
    pendingOperations: 0,
    indexedOperations: 0,
    failedOperations: 0,
    pendingUncommitted: 0,
  }
  // Construction is lazy (first upsert/search). No eager open: a transient failure must
  // stay retriable rather than latch the sidecar into a permanent degraded state.
  tail = previousTail.catch(() => undefined)
}

/** Queue one canonical terminal record for the independent Tantivy sidecar. */
export function enqueueTantivyOperation(record: ModelOperationRecord): Promise<void> {
  const captured = config
  const capturedGeneration = generation
  if (!captured) return Promise.resolve()
  const content = projectSearchableText(record)
  status = { ...status, pendingOperations: status.pendingOperations + 1 }
  const operation = tail.then(async () => {
    try {
      if (generation !== capturedGeneration) return
      const instance = await ensureInstance(captured)
      if (generation !== capturedGeneration) return
      await instance.upsert(record.identity.operationId, record.identity.kind, record.identity.createdAt, content)
      uncommitted += 1
      firstUncommittedAt ??= Date.now()
      if (generation === capturedGeneration) {
        status = { ...status, indexedOperations: status.indexedOperations + 1, state: "ready", pendingUncommitted: uncommitted }
      }
      scheduleFlush(capturedGeneration)
    } catch (error) {
      if (generation === capturedGeneration) {
        status = {
          ...status,
          failedOperations: status.failedOperations + 1,
          state: "degraded",
          lastError: errorText(error),
        }
      }
    } finally {
      if (generation === capturedGeneration) status = { ...status, pendingOperations: Math.max(0, status.pendingOperations - 1) }
    }
  })
  tail = operation.catch(() => undefined)
  return operation
}

/** Direct Tantivy query for sidecar tests/future API cutover; History APIs remain empty in this release. */
export async function searchTantivyOperations(query: string, operationKind: string | undefined, limit = 30): Promise<Array<TantivySearchHit>> {
  const captured = config
  if (!captured || limit <= 0 || query.trim().length === 0) return []
  try {
    const instance = await ensureInstance(captured)
    return await instance.search(query, operationKind, limit)
  } catch (error) {
    status = { ...status, state: "degraded", lastError: errorText(error) }
    return []
  }
}

export async function drainTantivySearch(): Promise<void> {
  // Synchronously clear the timer and enqueue a final flush BEFORE the first await, so
  // there is no "timer already fired but flush not yet enqueued" window (single-threaded
  // event loop). This is the drain-before-close guarantee for staged documents.
  enqueueFlush(generation)
  await tail
}

export function getTantivySearchStatus(): TantivySearchStatus {
  return { ...status, pendingUncommitted: uncommitted }
}

export function resetTantivySearchForTests(): void {
  clearFlushTimer()
  generation++
  config = undefined
  instancePromise = undefined
  uncommitted = 0
  firstUncommittedAt = undefined
  tail = Promise.resolve()
  status = { enabled: false, state: "disabled", pendingOperations: 0, indexedOperations: 0, failedOperations: 0, pendingUncommitted: 0 }
}
