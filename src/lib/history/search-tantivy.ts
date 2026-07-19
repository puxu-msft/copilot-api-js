import type { ModelOperationRecord } from "~/lib/context/model-operation-record"

import {
  //
  getNativeHistorySearch,
  type TantivySearchHit,
} from "./search-native"

export interface TantivySearchStatus {
  enabled: boolean
  state: "disabled" | "initializing" | "ready" | "degraded"
  path?: string
  pendingOperations: number
  indexedOperations: number
  failedOperations: number
  lastError?: string
}

interface TantivySearchConfig {
  enabled: boolean
  path: string
}

let config: TantivySearchConfig | undefined
let generation = 0
let tail: Promise<void> = Promise.resolve()
let status: TantivySearchStatus = {
  enabled: false,
  state: "disabled",
  pendingOperations: 0,
  indexedOperations: 0,
  failedOperations: 0,
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function searchableContent(record: ModelOperationRecord): string {
  return [...record.arena.payloads, ...record.arena.frames].map((node) => JSON.stringify(node.value)).join("\n")
}

async function initialize(captured: TantivySearchConfig, capturedGeneration: number): Promise<void> {
  try {
    const native = await getNativeHistorySearch()
    await native.initialize(captured.path)
    if (generation === capturedGeneration) status = { ...status, state: "ready", lastError: undefined }
  } catch (error) {
    if (generation === capturedGeneration) status = { ...status, state: "degraded", lastError: errorText(error) }
    throw error
  }
}

export function configureTantivySearch(next: TantivySearchConfig): void {
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
  }
  if (!config) {
    tail = previousTail.catch(() => undefined)
    return
  }
  const captured = config
  const capturedGeneration = generation
  tail = previousTail
    .catch(() => undefined)
    .then(() => initialize(captured, capturedGeneration))
    .catch(() => undefined)
}

/** Queue one canonical terminal record for the independent Tantivy sidecar. */
export function enqueueTantivyOperation(record: ModelOperationRecord): Promise<void> {
  const captured = config
  const capturedGeneration = generation
  if (!captured) return Promise.resolve()
  status = { ...status, pendingOperations: status.pendingOperations + 1 }
  const operation = tail.then(async () => {
    try {
      const native = await getNativeHistorySearch()
      await native.upsertOperation(captured.path, record.identity.operationId, record.identity.kind, record.identity.createdAt, searchableContent(record))
      if (generation === capturedGeneration) status = { ...status, indexedOperations: status.indexedOperations + 1, state: "ready" }
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
    const native = await getNativeHistorySearch()
    return await native.searchOperations(captured.path, query, operationKind, limit)
  } catch (error) {
    status = { ...status, state: "degraded", lastError: errorText(error) }
    return []
  }
}

export async function drainTantivySearch(): Promise<void> {
  await tail
}

export function getTantivySearchStatus(): TantivySearchStatus {
  return { ...status }
}

export function resetTantivySearchForTests(): void {
  generation++
  config = undefined
  tail = Promise.resolve()
  status = { enabled: false, state: "disabled", pendingOperations: 0, indexedOperations: 0, failedOperations: 0 }
}
