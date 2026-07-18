import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"

import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
} from "~/lib/observability"

import { getProcessIdentityQuiet } from "~/lib/process-identity"
import {
  //
  isProcessAlive,
  readProcStartTicks,
} from "~/lib/process-identity"

import type { StructuredFileRecord } from "./structured-file-sink"

import { writeEmergencyFallback } from "../emergency-output"

export interface BootstrapSpoolOptions {
  directory: string
  recoveryPaths?: ReadonlyArray<string>
  write?: (fd: number, buffer: Buffer, offset: number, length: number) => number
}

export type SpoolRecordVisitor = (record: StructuredFileRecord) => void

interface BootstrapSpoolLine {
  spoolId: string
  sequence: number
  digest: string
  record: StructuredFileRecord
}

interface LegacySequencedSpoolLine {
  sequence: number
  record: StructuredFileRecord
}

interface SpoolReadResult {
  records?: Array<StructuredFileRecord>
  malformedLines: number
}

let nextSpoolSequence = 0

export function resetBootstrapSpoolForTests(): void {
  nextSpoolSequence = 0
}

/** Secure crash-retained WAL for canonical boot records before the structured writer is ready. */
export class BootstrapDiagnosticSpool {
  readonly path: string
  readonly spoolId: string
  private readonly fd: number
  private readonly unsubscribe: () => void
  private readonly recoveryPaths: Array<string>
  private readonly write: NonNullable<BootstrapSpoolOptions["write"]>
  private readonly pendingCorrupt = new Map<string, number>()
  private mirror: ((record: StructuredFileRecord) => void) | undefined
  private retired = false
  private closed = false
  private failure: Error | undefined

  private constructor(bus: ObservabilityBus, options: BootstrapSpoolOptions) {
    const { directory } = options
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(directory, 0o700)
    this.recoveryPaths = [...new Set([...claimRecoverableSpools(discoverRecoverableSpools(directory)), ...(options.recoveryPaths ?? [])])]
    this.spoolId = crypto.randomUUID()
    const procStartTicks = getProcessIdentityQuiet().procStartTicks ?? readProcStartTicks(process.pid) ?? 0
    this.path = path.join(directory, `bootstrap-v2-${process.pid}-${procStartTicks}-${Date.now()}-${this.spoolId}.spool.ndjson`)
    this.fd = fs.openSync(this.path, "wx", 0o600)
    fsyncDirectory(directory)
    this.write = options.write ?? ((fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, length))
    this.unsubscribe = bus.subscribe(
      (event) => this.capture(event),
      (event) => event.kind === "system.diagnostic" || event.kind === "system.model_catalog" || event.kind === "system.request_line",
      { name: "bootstrap-diagnostic-spool" },
    )
  }

  static attach(bus: ObservabilityBus, options: BootstrapSpoolOptions): BootstrapDiagnosticSpool {
    return new BootstrapDiagnosticSpool(bus, options)
  }

  get recoveryArtifacts(): Array<string> {
    return [...this.recoveryPaths, this.path]
  }

  retireAndRead(): Array<StructuredFileRecord> {
    this.retireDurably()
    const records: Array<StructuredFileRecord> = []
    for (const spoolPath of [...this.recoveryPaths, this.path]) this.visitSpool(spoolPath, (record) => records.push(record))
    this.finalizeSnapshotIsolation()
    return records
  }

  retireDurably(): void {
    if (!this.retired) {
      this.retired = true
      this.unsubscribe()
      this.closeDurably()
    }
  }

  snapshotAndContinue(): Array<StructuredFileRecord> {
    const records: Array<StructuredFileRecord> = []
    this.forEachSnapshotRecord((record) => records.push(record))
    return records
  }

  forEachSnapshotRecord(visit: SpoolRecordVisitor): void {
    if (this.retired || this.closed) throw new Error("Bootstrap diagnostic spool is not capturing")
    fs.fsyncSync(this.fd)
    if (this.failure) throw this.failure
    for (const spoolPath of [...this.recoveryPaths, this.path]) this.visitSpool(spoolPath, visit)
  }

  finalizeSnapshotIsolation(): void {
    for (const [spoolPath, malformedLines] of this.pendingCorrupt) {
      const corruptPath = `${spoolPath}.corrupt-${Date.now()}`
      fs.renameSync(spoolPath, corruptPath)
      fsyncDirectory(path.dirname(spoolPath))
      writeEmergencyFallback(`[BootstrapDiagnosticSpool] retained ${malformedLines} malformed line(s) at ${corruptPath}`)
    }
    this.pendingCorrupt.clear()
  }

  private visitSpool(spoolPath: string, visit: SpoolRecordVisitor): void {
    const result = readSpoolRecords(spoolPath, visit)
    if (result.malformedLines > 0) this.pendingCorrupt.set(spoolPath, result.malformedLines)
  }

  setMirror(mirror: ((record: StructuredFileRecord) => void) | undefined): void {
    this.mirror = mirror
  }

  closeDurably(): void {
    if (this.closed) {
      if (this.failure) throw this.failure
      return
    }
    this.closed = true
    try {
      fs.fsyncSync(this.fd)
    } catch (error) {
      this.failure ??= asError(error)
    }
    try {
      fs.closeSync(this.fd)
    } catch (error) {
      this.failure ??= asError(error)
    }
    if (this.failure) throw this.failure
  }

  removeDurably(): void {
    this.closeDurably()
    for (const spoolPath of [...this.recoveryPaths, this.path]) fs.rmSync(spoolPath, { force: true })
    fsyncDirectory(path.dirname(this.path))
  }

  private capture(event: ObservabilityEvent): void {
    if (this.retired || this.closed) return
    let record: StructuredFileRecord | undefined
    switch (event.kind) {
      case "system.diagnostic": {
        record = { recordType: "diagnostic", diagnostic: event.diagnostic }
        break
      }
      case "system.model_catalog": {
        const catalog = { models: event.models, tokenBasedBilling: event.tokenBasedBilling, timeUnixMs: event.timeUnixMs }
        record = { recordType: "model-catalog", process: getProcessIdentityQuiet(), catalog }
        break
      }
      case "system.request_line": {
        record = { recordType: "request-line", timeUnixMs: Date.now(), process: getProcessIdentityQuiet(), parts: event.parts }
        break
      }
      default: {
        break
      }
    }
    if (!record) return
    const sequence = ++nextSpoolSequence
    const digest = digestRecord(record)
    const line: BootstrapSpoolLine = { spoolId: this.spoolId, sequence, digest, record }
    const buffer = Buffer.from(`${JSON.stringify(line)}\n`)
    let offset = 0
    try {
      while (offset < buffer.length) {
        const written = this.write(this.fd, buffer, offset, buffer.length - offset)
        if (written <= 0) throw new Error(`Bootstrap diagnostic spool write made no progress at byte ${offset}/${buffer.length}`)
        offset += written
      }
    } catch (error) {
      this.failure ??= asError(error)
    }
    if (!this.failure) this.mirror?.({ ...record, delivery: { spoolId: this.spoolId, sequence, digest } })
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function digestRecord(record: unknown): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("base64url")
}

function readSpoolRecords(spoolPath: string, visit: SpoolRecordVisitor): SpoolReadResult {
  let malformedLines = 0
  let legacySequence = 0
  const parseLine = (line: string) => {
    if (!line) return
    legacySequence++
    try {
      const parsed = JSON.parse(line) as BootstrapSpoolLine | LegacySequencedSpoolLine | StructuredFileRecord
      let record: StructuredFileRecord
      if (isBootstrapSpoolLine(parsed)) {
        if (digestRecord(parsed.record) !== parsed.digest) throw new Error("Structured diagnostic spool digest mismatch")
        record = { ...parsed.record, delivery: { spoolId: parsed.spoolId, sequence: parsed.sequence, digest: parsed.digest } }
      } else if (isLegacySequencedSpoolLine(parsed)) {
        record = {
          ...parsed.record,
          delivery: { spoolId: `legacy:${path.basename(spoolPath)}`, sequence: parsed.sequence, digest: digestRecord(parsed.record) },
        }
      } else
        record = {
          ...parsed,
          delivery: { spoolId: `legacy:${path.basename(spoolPath)}`, sequence: legacySequence, digest: digestRecord(parsed) },
        }
      if (!isStructuredFileRecord(record)) throw new Error("Invalid structured diagnostic spool record")
      visit(record)
    } catch {
      malformedLines++
    }
  }
  const fd = fs.openSync(spoolPath, "r")
  const decoder = new StringDecoder("utf8")
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let carry = ""
  try {
    while (true) {
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, null)
      if (bytes === 0) break
      carry += decoder.write(chunk.subarray(0, bytes))
      let newline = carry.indexOf("\n")
      while (newline !== -1) {
        parseLine(carry.slice(0, newline))
        carry = carry.slice(newline + 1)
        newline = carry.indexOf("\n")
      }
    }
    carry += decoder.end()
    if (carry) parseLine(carry)
  } finally {
    fs.closeSync(fd)
  }
  return { malformedLines }
}

function isBootstrapSpoolLine(value: BootstrapSpoolLine | LegacySequencedSpoolLine | StructuredFileRecord): value is BootstrapSpoolLine {
  return (
    "spoolId" in value
    && "sequence" in value
    && "digest" in value
    && "record" in value
    && typeof value.spoolId === "string"
    && typeof value.sequence === "number"
    && typeof value.digest === "string"
  )
}

function isLegacySequencedSpoolLine(value: LegacySequencedSpoolLine | StructuredFileRecord): value is LegacySequencedSpoolLine {
  return "sequence" in value && "record" in value && typeof value.sequence === "number"
}

function isStructuredFileRecord(value: unknown): value is StructuredFileRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<StructuredFileRecord>
  if (record.recordType === "diagnostic") {
    const diagnostic = record.diagnostic as
      | { schemaVersion?: unknown; timeUnixMs?: unknown; severity?: unknown; event?: unknown; message?: unknown; process?: unknown }
      | undefined
    return (
      diagnostic?.schemaVersion === 1
      && typeof diagnostic.timeUnixMs === "number"
      && ["debug", "error", "fatal", "info", "trace", "warn"].includes(String(diagnostic.severity))
      && typeof diagnostic.event === "string"
      && typeof diagnostic.message === "string"
      && typeof diagnostic.process === "object"
    )
  }
  if (record.recordType === "request-line") {
    const parts = record.parts as { method?: unknown; path?: unknown } | undefined
    return typeof parts?.method === "string" && typeof parts.path === "string"
  }
  if (record.recordType === "model-catalog") {
    const catalog = record.catalog as { models?: unknown; timeUnixMs?: unknown; tokenBasedBilling?: unknown } | undefined
    return Array.isArray(catalog?.models) && typeof catalog.timeUnixMs === "number" && typeof catalog.tokenBasedBilling === "boolean"
  }
  return false
}

function discoverRecoverableSpools(directory: string): Array<string> {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isRecoverableSpoolName(entry.name))
    .filter((entry) => {
      const claims = [...entry.name.matchAll(/\.claim-v1-(\d+)-(\d+)-[\da-f-]+/gi)]
      const claim = claims.at(-1)
      if (claim) return !ownerMatchesLiveProcess(Number(claim[1]), Number(claim[2]))
      const v2 = /^bootstrap-v2-(\d+)-(\d+)-/.exec(entry.name)
      const legacy = /^bootstrap-(\d+)-/.exec(entry.name)
      const pid = Number(v2?.[1] ?? legacy?.[1])
      if (!Number.isSafeInteger(pid)) return false
      if (!isProcessAlive(pid)) return true
      if (!v2) return false
      const expectedStartTicks = Number(v2[2])
      return !ownerMatchesLiveProcess(pid, expectedStartTicks)
    })
    .map((entry) => path.join(directory, entry.name))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
}

function isRecoverableSpoolName(name: string): boolean {
  const unclaimed = stripClaimSuffix(name)
  return /^bootstrap-\d+-\d+-[\da-f-]+\.spool\.ndjson$/i.test(unclaimed) || /^bootstrap-v2-\d+-\d+-\d+-[\da-f-]+\.spool\.ndjson$/i.test(unclaimed)
}

function ownerMatchesLiveProcess(pid: number, expectedStartTicks: number): boolean {
  if (!isProcessAlive(pid)) return false
  const actualStartTicks = readProcStartTicks(pid)
  return actualStartTicks === undefined || actualStartTicks === expectedStartTicks
}

function claimRecoverableSpools(paths: ReadonlyArray<string>): Array<string> {
  const procStartTicks = getProcessIdentityQuiet().procStartTicks ?? readProcStartTicks(process.pid) ?? 0
  const claimed: Array<string> = []
  for (const spoolPath of paths) {
    const claimPath = `${stripClaimSuffix(spoolPath)}.claim-v1-${process.pid}-${procStartTicks}-${crypto.randomUUID()}`
    try {
      fs.renameSync(spoolPath, claimPath)
      fsyncDirectory(path.dirname(spoolPath))
      claimed.push(claimPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return claimed
}

function stripClaimSuffix(value: string): string {
  return value.replace(/(?:\.claim-v1-\d+-\d+-[\da-f-]+)+$/i, "")
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(directory, "r")
    fs.fsyncSync(fd)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
