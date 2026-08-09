import type { ModelOperationRecord } from "~/lib/context/model-operation-record"
import type {
  //
  HistoryPersistenceOutcome,
  ModelOperationTerminalPublication,
} from "~/lib/history/worker/protocol"

type MainThreadTerminalPublication = ModelOperationTerminalPublication<ModelOperationRecord>

import {
  //
  getRecentTerminal,
  getRecentTerminalDurability,
  listRecentTerminals,
  publishPendingTerminal,
  resetRecentTerminals,
  settleTerminalDurability,
} from "../recent-terminal"

export type ModelOperationTerminalSubscriber = (publication: MainThreadTerminalPublication) => void | Promise<void>

const subscribers = new Set<ModelOperationTerminalSubscriber>()
const pendingSubscribers = new Set<Promise<void>>()

/** Subscribe to complete immutable terminal publications. Returns an unsubscribe function. */
export function subscribeModelOperationTerminals(subscriber: ModelOperationTerminalSubscriber): () => void {
  subscribers.add(subscriber)
  return () => subscribers.delete(subscriber)
}

/**
 * Publish without delaying the proxy response. Async subscribers are tracked for
 * shutdown/test drains; every rejection is observed so it cannot crash the process.
 */
export function publishModelOperationTerminal(publication: MainThreadTerminalPublication): void {
  publishPendingTerminal(publication)
  for (const subscriber of subscribers) {
    try {
      const result = subscriber(publication)
      if (result instanceof Promise) {
        const tracked = result.catch(() => undefined).finally(() => pendingSubscribers.delete(tracked))
        pendingSubscribers.add(tracked)
      }
    } catch {
      // Persistence/derived consumers may fail, but model delivery must not.
    }
  }
}

export function getRecentModelOperationTerminal(operationId: string) {
  return getRecentTerminal(operationId)
}

export function listRecentModelOperationTerminals() {
  return listRecentTerminals()
}

export function getRecentModelOperationDurability(operationId: string): "pending" | "failed" | undefined {
  return getRecentTerminalDurability(operationId)
}

export function settleRecentModelOperationDurability(publication: MainThreadTerminalPublication, outcome: HistoryPersistenceOutcome): void {
  settleTerminalDurability(publication, outcome)
}

/** Test-only cache clear used by the legacy fixture reset surface. */
export function clearRecentModelOperationTerminalsForTests(): void {
  resetRecentTerminals()
}

/** Drain to quiescence, including work published while a prior batch settles. */
export async function drainModelOperationTerminalSubscribers(): Promise<void> {
  while (pendingSubscribers.size > 0) await Promise.allSettled(pendingSubscribers)
}

export function resetModelOperationTerminalBusForTests(): void {
  subscribers.clear()
  pendingSubscribers.clear()
  resetRecentTerminals()
}
