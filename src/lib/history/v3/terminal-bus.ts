import type { ModelOperationRecord } from "~/lib/context/model-operation-record"

export type ModelOperationTerminalSubscriber = (record: ModelOperationRecord) => void | Promise<void>

const subscribers = new Set<ModelOperationTerminalSubscriber>()
const pending = new Set<Promise<void>>()
const recent = new Map<string, ModelOperationRecord>()
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
  while (recent.size > RECENT_CAPACITY) {
    const oldest = recent.keys().next().value
    if (oldest === undefined) break
    recent.delete(oldest)
  }
  for (const subscriber of subscribers) {
    try {
      const result = subscriber(record)
      if (result instanceof Promise) {
        let tracked: Promise<void>
        tracked = result
          .catch(() => undefined)
          .finally(() => pending.delete(tracked))
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

/** Drain to quiescence, including work published while a prior batch settles. */
export async function drainModelOperationTerminalSubscribers(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending])
}

export function resetModelOperationTerminalBusForTests(): void {
  subscribers.clear()
  pending.clear()
  recent.clear()
}
