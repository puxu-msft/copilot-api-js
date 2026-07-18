import type { ObservabilityBus } from "~/lib/observability"

import {
  //
  BootstrapDiagnosticSpool,
  resetBootstrapSpoolForTests,
} from "./bootstrap-spool"
import { collectCommittedSpoolDeliveries } from "./segment-files"
import {
  //
  StructuredFileSink,
  type StructuredFileSinkOptions,
} from "./structured-file-sink"

let activeSink: StructuredFileSink | undefined
let activeSpool: BootstrapDiagnosticSpool | undefined
let lifecycleTail: Promise<void> = Promise.resolve()
let lifecycleGeneration = 0
const shutdownBarriers = new Map<number, Promise<void>>()

export function attachBootstrapDiagnosticSpool(bus: ObservabilityBus, directory: string): BootstrapDiagnosticSpool {
  if (activeSpool) return activeSpool
  ensureWritableGeneration()
  activeSpool = BootstrapDiagnosticSpool.attach(bus, { directory })
  return activeSpool
}

export async function attachStructuredFileSink(bus: ObservabilityBus, options: StructuredFileSinkOptions): Promise<StructuredFileSink> {
  ensureWritableGeneration()
  return enqueueLifecycle(async () => {
    if (activeSink) throw new Error("Structured file sink already attached")
    const sink = await StructuredFileSink.createDetached(options)
    const spool = activeSpool
    try {
      if (spool) {
        sink.disableRuntimePruning()
      } else sink.activate(bus)
      activeSink = sink
      const wanted = new Set<string>()
      spool?.forEachSnapshotRecord((record) => {
        if (record.delivery) wanted.add(deliveryKey(record.delivery))
      })
      const committed = collectCommittedSpoolDeliveries(options.directory, wanted)
      spool?.forEachSnapshotRecord((record) => {
        const key = record.delivery && deliveryKey(record.delivery)
        if (!key || !committed.has(key)) sink.writeRecord(record)
      })
      spool?.finalizeSnapshotIsolation()
      await sink.durable()
      // WAL remains the sole bus subscriber for the full process lifetime.
      // Every new record reaches the sink only after its WAL write succeeds.
      spool?.setMirror((record) => sink.writeRecord(record))
    } catch (error) {
      activeSink = undefined
      spool?.setMirror(undefined)
      const closeFailure = sink.close().catch(() => {})
      sink.detach()
      await closeFailure
      throw error
    }
    return sink
  })
}

export function shutdownStructuredFileSink(): Promise<void> {
  const generation = lifecycleGeneration
  const existing = shutdownBarriers.get(generation)
  if (existing) return existing
  const barrier = enqueueLifecycle(async () => {
    const sink = activeSink
    activeSink = undefined
    const spool = activeSpool
    activeSpool = undefined
    spool?.retireDurably()
    if (sink) {
      await sink.close()
      spool?.removeDurably()
    } else spool?.closeDurably()
  })
  shutdownBarriers.set(generation, barrier)
  return barrier
}

export function disableStructuredFileLogging(): Promise<void> {
  return enqueueLifecycle(async () => {
    const spool = activeSpool
    activeSpool = undefined
    if (!spool) return
    spool.retireDurably()
    spool.removeDurably()
  })
}

export function resetStructuredFileSinkForTests(): void {
  activeSink = undefined
  activeSpool = undefined
  lifecycleTail = Promise.resolve()
  lifecycleGeneration = 0
  shutdownBarriers.clear()
  resetBootstrapSpoolForTests()
}

export { BootstrapDiagnosticSpool } from "./bootstrap-spool"
export { CountingDestination } from "./counting-destination"
export { DurableFileWriter } from "./durable-writer"
export { createOwnerManifest, ownerIsDefinitelyDead, readOwnerManifest } from "./owner-manifest"
export { sweepDiagnosticRetention } from "./retention"

export type { StructuredFileRecord, StructuredFileSinkOptions } from "./structured-file-sink"
export { StructuredFileSink } from "./structured-file-sink"
export type { DiagnosticDestinationHealth, DiagnosticWriterHealth, DiagnosticWriterState, SyncDiagnosticSegments } from "./types"

function enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycleTail.then(operation)
  lifecycleTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function ensureWritableGeneration(): void {
  if (lifecycleGeneration === 0 || shutdownBarriers.has(lifecycleGeneration)) lifecycleGeneration++
}

function deliveryKey(delivery: { spoolId: string; sequence: number; digest: string }): string {
  return `${delivery.spoolId}:${delivery.sequence}:${delivery.digest}`
}
