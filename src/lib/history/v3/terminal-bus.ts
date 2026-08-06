import type { ModelOperationRecord } from "~/lib/context/model-operation-record"

export type ModelOperationTerminalSubscriber = (record: ModelOperationRecord) => void | Promise<void>

const subscribers = new Set<ModelOperationTerminalSubscriber>()
const pending = new Set<Promise<void>>()
const recent = new Map<string, ModelOperationRecord>()
const recentDurability = new Map<string, "pending" | "failed">()
const RECENT_CAPACITY = 256

/** Subscribe to immutable canonical terminal records. Returns an unsubscribe function. */
export function subscribeModelOperationTerminals(subscriber: ModelOperationTerminalSubscriber): () => void {
  subscribers.add(subscriber)
  return () => subscribers.delete(subscriber)
}

/**
 * Publish without delaying the proxy response. Async subscribers are tracked for
 * shutdown/test drains; every rejection is observed so it cannot crash the process.
 */
export function publishModelOperationTerminal(record: ModelOperationRecord): void {
  recent.set(record.identity.operationId, record)
  recentDurability.set(record.identity.operationId, "pending")
  while (recent.size > RECENT_CAPACITY) {
    const oldest = recent.keys().next().value
    if (oldest === undefined) break
    recent.delete(oldest)
    recentDurability.delete(oldest)
  }
  for (const subscriber of subscribers) {
    try {
      const result = subscriber(record)
      if (result instanceof Promise) {
        const tracked = result.catch(() => undefined).finally(() => pending.delete(tracked))
        pending.add(tracked)
      }
    } catch {
      // Persistence/derived consumers may fail, but model delivery must not.
    }
  }
}

export function getRecentModelOperationTerminal(operationId: string): ModelOperationRecord | undefined {
  return recent.get(operationId)
}

export function listRecentModelOperationTerminals(): ReadonlyArray<ModelOperationRecord> {
  return [...recent.values()]
}

export function getRecentModelOperationDurability(operationId: string): "pending" | "failed" | undefined {
  return recentDurability.get(operationId)
}

export function settleRecentModelOperationDurability(record: ModelOperationRecord, outcome: "persisted" | "failed" | "conflict"): void {
  const operationId = record.identity.operationId
  if (recent.get(operationId) !== record) return
  if (outcome === "persisted") {
    recentDurability.delete(operationId)
  } else {
    recentDurability.set(operationId, "failed")
  }
}

/** Test-only cache clear used by the legacy fixture reset surface. */
export function clearRecentModelOperationTerminalsForTests(): void {
  recent.clear()
  recentDurability.clear()
}

/** Drain to quiescence, including work published while a prior batch settles. */
export async function drainModelOperationTerminalSubscribers(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled(pending)
}

export function resetModelOperationTerminalBusForTests(): void {
  subscribers.clear()
  pending.clear()
  recent.clear()
  recentDurability.clear()
}
