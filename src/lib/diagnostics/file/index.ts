import type { ObservabilityBus } from "~/lib/observability"

import { BootstrapDiagnosticSpool } from "./bootstrap-spool"
import {
  //
  StructuredFileSink,
  type StructuredFileSinkOptions,
} from "./structured-file-sink"

let activeSink: StructuredFileSink | undefined
let activeSpool: BootstrapDiagnosticSpool | undefined

export function attachBootstrapDiagnosticSpool(bus: ObservabilityBus, directory: string): BootstrapDiagnosticSpool {
  if (activeSpool) return activeSpool
  activeSpool = BootstrapDiagnosticSpool.attach(bus, { directory })
  return activeSpool
}

export async function attachStructuredFileSink(bus: ObservabilityBus, options: StructuredFileSinkOptions): Promise<StructuredFileSink> {
  const sink = await StructuredFileSink.createDetached(options)
  const spool = activeSpool
  const records = spool?.retireAndRead() ?? []
  sink.activate(bus)
  for (const record of records) sink.writeRecord(record)
  await sink.durable()
  spool?.removeDurably()
  activeSpool = undefined
  activeSink = sink
  return sink
}

export async function shutdownStructuredFileSink(): Promise<void> {
  const sink = activeSink
  activeSink = undefined
  if (sink) await sink.close()
  const spool = activeSpool
  activeSpool = undefined
  spool?.closeDurably()
}

export function disableStructuredFileLogging(): void {
  const spool = activeSpool
  activeSpool = undefined
  if (!spool) return
  spool.retireAndRead()
  spool.removeDurably()
}

export function resetStructuredFileSinkForTests(): void {
  activeSink = undefined
  activeSpool = undefined
}

export { BootstrapDiagnosticSpool } from "./bootstrap-spool"
export { createOwnerManifest, ownerIsDefinitelyDead, readOwnerManifest } from "./owner-manifest"
export { sweepDiagnosticRetention } from "./retention"

export type { StructuredFileRecord, StructuredFileSinkOptions } from "./structured-file-sink"
export { StructuredFileSink } from "./structured-file-sink"
