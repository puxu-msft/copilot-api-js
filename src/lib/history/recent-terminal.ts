import type { ModelOperationRecord } from "~/lib/context/model-operation-record"

import type {
  //
  HistoryPersistenceOutcome,
  ModelOperationTerminalPublication,
} from "./worker/protocol"

type MainThreadTerminalPublication = ModelOperationTerminalPublication<ModelOperationRecord>

const ACKNOWLEDGED_RECENT_CAPACITY = 256

interface AcknowledgedTerminal {
  readonly record: ModelOperationRecord
  readonly durability?: "failed"
}

const pending = new Map<string, MainThreadTerminalPublication>()
const acknowledged = new Map<string, AcknowledgedTerminal>()

export function publishPendingTerminal(publication: MainThreadTerminalPublication): void {
  const operationId = publication.record.identity.operationId
  pending.set(operationId, publication)
  acknowledged.delete(operationId)
}

export function settleTerminalDurability(publication: MainThreadTerminalPublication, outcome: HistoryPersistenceOutcome): void {
  const operationId = publication.record.identity.operationId
  if (pending.get(operationId) !== publication) return
  pending.delete(operationId)
  acknowledged.set(operationId, {
    record: publication.record,
    ...(outcome === "failed" && { durability: "failed" as const }),
  })
  while (acknowledged.size > ACKNOWLEDGED_RECENT_CAPACITY) {
    const oldest = acknowledged.keys().next().value
    if (oldest === undefined) break
    acknowledged.delete(oldest)
  }
}

export function getRecentTerminal(operationId: string): ModelOperationRecord | undefined {
  return pending.get(operationId)?.record ?? acknowledged.get(operationId)?.record
}

export function listRecentTerminals(): ReadonlyArray<ModelOperationRecord> {
  return [...pending.values()].map(({ record }) => record).concat([...acknowledged.values()].map(({ record }) => record))
}

export function getRecentTerminalDurability(operationId: string): "pending" | "failed" | undefined {
  if (pending.has(operationId)) return "pending"
  return acknowledged.get(operationId)?.durability
}

export function resetRecentTerminals(): void {
  pending.clear()
  acknowledged.clear()
}
