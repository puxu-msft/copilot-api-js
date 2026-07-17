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
import { createOwnerManifest } from "./owner-manifest"
import { sweepDiagnosticRetention } from "./retention"

export type StructuredFileRecord =
  | { recordType: "diagnostic"; diagnostic: DiagnosticEvent }
  | { recordType: "request-line"; timeUnixMs: number; process: ReturnType<typeof getProcessIdentityQuiet>; parts: LogLineParts }

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
  private readonly counted: CountingDestination
  private readonly baseName: string
  private readonly maxFilesPerProcess: number
  private state: "ready" | "degraded" | "sealing" | "closed" = "ready"
  private droppedRecords = 0
  private writesSincePrune = 0
  private readonly level: DiagnosticLevelThreshold | (() => DiagnosticLevelThreshold)

  private constructor(
    directory: string,
    baseName: string,
    destination: PinoRollDestination,
    maxFilesPerProcess: number,
    level: DiagnosticLevelThreshold | (() => DiagnosticLevelThreshold),
  ) {
    this.destination = destination
    this.counted = new CountingDestination(destination)
    this.baseName = baseName
    this.maxFilesPerProcess = maxFilesPerProcess
    this.level = level
    this.logger = pino(
      {
        base: null,
        timestamp: false,
        redact: { paths: ["record.diagnostic.fields.*.value.access_token", "record.diagnostic.fields.*.value.authorization"], censor: "[REDACTED]" },
      },
      this.counted,
    )
    this.counted.on("drop", () => {
      this.droppedRecords++
      this.state = "degraded"
    })
    this.counted.on("error", (error: Error) => {
      this.state = "degraded"
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
      ...((options.maxSizeBytes ?? 10 * 1024 * 1024) > 0 && { size: options.maxSizeBytes ?? 10 * 1024 * 1024 }),
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

  get health(): { state: string; droppedRecords: number; activePath: string; queuedBytes: number; writtenBytes: number; droppedBytes: number } {
    return { state: this.state, droppedRecords: this.droppedRecords, activePath: this.destination.file, ...this.counted.health }
  }

  async close(): Promise<void> {
    if (this.state === "closed" || this.state === "sealing") return
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.writeRecord({
      recordType: "diagnostic",
      diagnostic: createDiagnosticEvent({ level: "info", event: "shutdown.diagnostic-sealing", message: "Diagnostic writer sealing", origin: "native" }),
    })
    this.state = "sealing"
    await this.durable()
    this.destination.end()
    await new Promise<void>((resolve, reject) => {
      this.destination.once("close", resolve)
      this.destination.once("error", reject)
    })
    this.state = "closed"
  }

  private handle(event: ObservabilityEvent): void {
    if (this.state !== "ready") return
    if (event.kind === "system.diagnostic") {
      const threshold = typeof this.level === "function" ? this.level() : this.level
      if (!isDiagnosticLevelEnabled(event.diagnostic.severity, threshold)) return
      this.writeRecord({ recordType: "diagnostic", diagnostic: event.diagnostic })
      return
    }
    if (event.kind === "system.request_line") {
      this.writeRecord({ recordType: "request-line", timeUnixMs: Date.now(), process: getProcessIdentityQuiet(), parts: event.parts })
    }
  }

  writeRecord(record: StructuredFileRecord): void {
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
      if (++this.writesSincePrune >= 100) {
        this.writesSincePrune = 0
        this.pruneOwnSegments()
      }
    } catch (error) {
      this.state = "degraded"
      writeEmergencyFallback(`[StructuredFileSink] ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async durable(): Promise<void> {
    await this.flush()
    await this.counted.waitForIdle()
    await this.fsyncSegments(this.counted.takeDirtyPaths())
  }

  private flush(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.destination.flush((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private async fsyncSegments(dirtyPaths: Array<string>): Promise<void> {
    const directory = path.dirname(this.baseName)
    const prefix = path.basename(this.baseName)
    const discovered = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".ndjson"))
      .map((name) => path.join(directory, name))
    const files = [...new Set([...dirtyPaths, ...discovered])]
    await Promise.all(
      files.map(async (file) => {
        const handle = await fs.promises.open(file, "r")
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }),
    )
  }

  private pruneOwnSegments(): void {
    if (this.maxFilesPerProcess <= 0) return
    try {
      const directory = path.dirname(this.baseName)
      const prefix = path.basename(this.baseName, ".ndjson")
      const active = this.destination.file
      const files = fs
        .readdirSync(directory)
        .filter((name) => name.startsWith(prefix) && name.endsWith(".ndjson"))
        .map((name) => ({ path: path.join(directory, name), mtime: fs.statSync(path.join(directory, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      for (const file of files.slice(this.maxFilesPerProcess)) {
        if (file.path !== active) fs.rmSync(file.path, { force: true })
      }
    } catch (error) {
      this.state = "degraded"
      writeEmergencyFallback(`[StructuredFileSink] retention failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
