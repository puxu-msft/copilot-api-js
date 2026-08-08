import type { HistoryPersistenceRuntime } from "./runtime"

import { resolveHistoryWorkerUrl } from "./asset-url"
import { HistoryPersistenceRuntimeImpl } from "./runtime"

let runtime: HistoryPersistenceRuntime | undefined

export function getHistoryPersistenceRuntime(): HistoryPersistenceRuntime {
  return (runtime ??= new HistoryPersistenceRuntimeImpl({ workerUrl: resolveHistoryWorkerUrl() }))
}

export function peekHistoryPersistenceRuntime(): HistoryPersistenceRuntime | undefined {
  return runtime
}

export function setHistoryPersistenceRuntimeForTests(value: HistoryPersistenceRuntime | undefined): void {
  runtime = value
}

/** Shut down the registry-owned runtime before releasing its singleton reference. */
export async function resetHistoryPersistenceRuntimeForTests(): Promise<void> {
  const current = runtime
  if (!current) return
  await current.shutdown()
  if (runtime === current) runtime = undefined
}
