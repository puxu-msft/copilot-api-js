export interface DiagnosticDestinationHealth {
  acceptedBytes: number
  settledBytes: number
  queuedBytes: number
  writtenBytes: number
  droppedBytes: number
}

export type DiagnosticWriterState = "starting" | "ready" | "degraded" | "sealing" | "closed" | "failed"

export interface DiagnosticWriterHealth extends DiagnosticDestinationHealth {
  state: DiagnosticWriterState
  activePath?: string
  lastError?: Error
}

export type SyncDiagnosticSegments = (baseName: string, dirtyPaths: ReadonlyArray<string>) => Promise<void>
