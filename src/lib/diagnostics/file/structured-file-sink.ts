import type { PinoRollDestination } from "pino-roll"

import fs from "node:fs"
import path from "node:path"
import pino from "pino"
import buildRoll from "pino-roll"

import type { DiagnosticEvent } from "~/lib/diagnostics"
import type { DiagnosticLevelThreshold } from "~/lib/diagnostics"
import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
} from "~/lib/observability"
import type { LogLineParts } from "~/lib/observability/projections/log-line"

import { isDiagnosticLevelEnabled } from "~/lib/diagnostics"
import { writeEmergencyFallback } from "~/lib/diagnostics/emergency-output"
import { getProcessIdentityQuiet } from "~/lib/process-identity"

import { createDiagnosticEvent } from "../event"
import { CountingDestination } from "./counting-destination"
import { DurableFileWriter } from "./durable-writer"
import { createOwnerManifest } from "./owner-manifest"
import { sweepDiagnosticRetention } from "./retention"
import { listDiagnosticSegments } from "./segment-files"

export interface SpoolDeliveryIdentity {
  spoolId: string
  sequence: number
  digest: string
}

export type StructuredFileRecord = (
  | { recordType: "diagnostic"; diagnostic: DiagnosticEvent }
  | { recordType: "request-line"; timeUnixMs: number; process: ReturnType<typeof getProcessIdentityQuiet>; parts: LogLineParts }
) & { delivery?: SpoolDeliveryIdentity }

export interface StructuredFileSinkOptions {
  directory: string
  maxSizeBytes?: number
  maxLengthBytes?: number
  maxFilesPerProcess?: number
  retentionDays?: number
  level?: DiagnosticLevelThreshold | (() => DiagnosticLevelThreshold)
}

export class StructuredFileSink {
  private unsubscribe: (() => void) | undefined
  private readonly logger: pino.Logger
  private readonly destination: PinoRollDestination
  private readonly writer: DurableFileWriter
  private readonly baseName: string
  private readonly maxFilesPerProcess: number
  private accepting = true
  private droppedRecords = 0
  private droppedAfterClose = 0
  private writesSincePrune = 0
  private pruningEnabled = true
  private maintenanceTail: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | undefined
  private readonly level: DiagnosticLevelThreshold | (() => DiagnosticLevelThreshold)

  private constructor(
    directory: string,
    baseName: string,
    destination: PinoRollDestination,
    maxFilesPerProcess: number,
    level: DiagnosticLevelThreshold | (() => DiagnosticLevelThreshold),
  ) {
    this.destination = destination
    const counted = new CountingDestination(destination)
    this.writer = new DurableFileWriter(destination, counted, baseName)
    this.baseName = baseName
    this.maxFilesPerProcess = maxFilesPerProcess
    this.level = level
    this.logger = pino(
      {
        base: null,
        level: "trace",
        timestamp: false,
        redact: { paths: ["record.diagnostic.fields.*.value.access_token", "record.diagnostic.fields.*.value.authorization"], censor: "[REDACTED]" },
      },
      counted,
    )
    counted.on("drop", () => {
      this.droppedRecords++
    })
    counted.on("error", (error: Error) => {
      writeEmergencyFallback(`[StructuredFileSink] ${error.message}`)
    })
    void directory
  }

  static async create(bus: ObservabilityBus, options: StructuredFileSinkOptions): Promise<StructuredFileSink> {
    const sink = await StructuredFileSink.createDetached(options)
    sink.activate(bus)
    return sink
  }

  static async createDetached(options: StructuredFileSinkOptions): Promise<StructuredFileSink> {
    fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(options.directory, 0o700)
    const identity = getProcessIdentityQuiet()
    const artifactStem = `copilot-api-${identity.bootTime}-${identity.pid}`
    createOwnerManifest(options.directory, identity, artifactStem)
    sweepDiagnosticRetention(options.directory, options.retentionDays ?? 7)
    const baseName = path.join(options.directory, `${artifactStem}.ndjson`)
    const destination = await buildRoll({
      file: baseName,
      ...((options.maxSizeBytes ?? 10 * 1024 * 1024) > 0 && { size: `${options.maxSizeBytes ?? 10 * 1024 * 1024}b` }),
      frequency: "daily",
      dateFormat: "yyyy-MM-dd",
      mkdir: true,
      mode: 0o600,
      minLength: 4096,
      maxLength: options.maxLengthBytes ?? 4 * 1024 * 1024,
      symlink: false,
    })
    if (destination.fd < 0) {
      await new Promise<void>((resolve, reject) => {
        destination.once("ready", resolve)
        destination.once("error", reject)
      })
    }
    if (destination.file) fs.chmodSync(destination.file, 0o600)
    const sink = new StructuredFileSink(options.directory, baseName, destination, options.maxFilesPerProcess ?? 7, options.level ?? "debug")
    sink.pruneOwnSegments()
    return sink
  }

  activate(bus: ObservabilityBus): void {
    if (this.unsubscribe) throw new Error("StructuredFileSink already active")
    this.unsubscribe = bus.subscribe(
      (event) => this.handle(event),
      (event) => event.kind === "system.diagnostic" || event.kind === "system.request_line",
      { name: "structured-file-sink" },
    )
  }

  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  reportMaintenanceFailure(error: unknown): void {
    this.writer.recordFailure(error)
  }

  disableRuntimePruning(): void {
    this.pruningEnabled = false
  }

  get health(): {
    state: string
    droppedRecords: number
    droppedAfterClose: number
    activePath: string
    acceptedBytes: number
    settledBytes: number
    queuedBytes: number
    writtenBytes: number
    droppedBytes: number
  } {
    return { ...this.writer.health, droppedRecords: this.droppedRecords, droppedAfterClose: this.droppedAfterClose, activePath: this.destination.file }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.accepting = false
    this.closePromise = this.closeAfterMaintenance()
    return this.closePromise
  }

  private async closeAfterMaintenance(): Promise<void> {
    await this.maintenanceTail
    await this.writer.close(() => {
      this.writeRecordInternal({
        recordType: "diagnostic",
        diagnostic: createDiagnosticEvent({ level: "info", event: "shutdown_diagnostic_sealing", message: "Diagnostic writer sealing", origin: "native" }),
      })
    })
  }

  private handle(event: ObservabilityEvent): void {
    if (!this.accepting) {
      this.droppedAfterClose++
      return
    }
    if (event.kind === "system.diagnostic") {
      this.writeRecord({ recordType: "diagnostic", diagnostic: event.diagnostic })
      return
    }
    if (event.kind === "system.request_line") {
      this.writeRecord({ recordType: "request-line", timeUnixMs: Date.now(), process: getProcessIdentityQuiet(), parts: event.parts })
    }
  }

  writeRecord(record: StructuredFileRecord): void {
    if (!this.accepting) {
      this.droppedAfterClose++
      return
    }
    if (record.recordType === "diagnostic") {
      const threshold = typeof this.level === "function" ? this.level() : this.level
      if (!isDiagnosticLevelEnabled(record.diagnostic.severity, threshold)) return
    }
    this.writeRecordInternal(record)
  }

  private writeRecordInternal(record: StructuredFileRecord): void {
    const level = record.recordType === "diagnostic" ? record.diagnostic.severity : "info"
    const message = record.recordType === "diagnostic" ? record.diagnostic.message : `${record.parts.method} ${record.parts.path}`
    try {
      switch (level) {
        case "trace": {
          this.logger.trace({ record }, message)
          break
        }
        case "debug": {
          this.logger.debug({ record }, message)
          break
        }
        case "warn": {
          this.logger.warn({ record }, message)
          break
        }
        case "error": {
          this.logger.error({ record }, message)
          break
        }
        case "fatal": {
          this.logger.fatal({ record }, message)
          break
        }
        default: {
          this.logger.info({ record }, message)
        }
      }
      if (this.pruningEnabled && ++this.writesSincePrune >= 100) {
        this.writesSincePrune = 0
        this.schedulePrune()
      }
    } catch (error) {
      this.writer.recordFailure(error)
      writeEmergencyFallback(`[StructuredFileSink] ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async durable(): Promise<void> {
    await this.maintenanceTail
    await this.writer.durable()
  }

  private schedulePrune(): void {
    this.maintenanceTail = this.maintenanceTail
      .then(async () => {
        await this.writer.durable()
        this.pruneOwnSegments()
        await this.writer.durable()
      })
      .catch((error: unknown) => {
        this.writer.recordFailure(error)
      })
  }

  private pruneOwnSegments(): void {
    if (this.maxFilesPerProcess <= 0) return
    try {
      const active = this.destination.file
      const files = listDiagnosticSegments(this.baseName)
        .map((file) => ({ path: file, mtime: fs.statSync(file).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      for (const file of files.slice(this.maxFilesPerProcess)) {
        if (file.path !== active) fs.rmSync(file.path, { force: true })
      }
    } catch (error) {
      this.writer.recordFailure(error)
      writeEmergencyFallback(`[StructuredFileSink] retention failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
