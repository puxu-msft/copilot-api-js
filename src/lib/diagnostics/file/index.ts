import type { ObservabilityBus } from "~/lib/observability"

import {
  //
  StructuredFileSink,
  type StructuredFileSinkOptions,
} from "./structured-file-sink"

let activeSink: StructuredFileSink | undefined

export async function attachStructuredFileSink(bus: ObservabilityBus, options: StructuredFileSinkOptions): Promise<StructuredFileSink> {
  const sink = await StructuredFileSink.create(bus, options)
  activeSink = sink
  return sink
}

export async function shutdownStructuredFileSink(): Promise<void> {
  const sink = activeSink
  activeSink = undefined
  await sink?.close()
}

export function resetStructuredFileSinkForTests(): void {
  activeSink = undefined
}

export type { StructuredFileRecord, StructuredFileSinkOptions } from "./structured-file-sink"

export { StructuredFileSink } from "./structured-file-sink"
