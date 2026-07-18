import fs from "node:fs"
import path from "node:path"

import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
} from "~/lib/observability"

import { getProcessIdentityQuiet } from "~/lib/process-identity"

import type { StructuredFileRecord } from "./structured-file-sink"

export interface BootstrapSpoolOptions {
  directory: string
}

/** Secure crash-retained WAL for canonical boot records before the structured writer is ready. */
export class BootstrapDiagnosticSpool {
  readonly path: string
  private readonly fd: number
  private readonly unsubscribe: () => void
  private retired = false
  private closed = false

  private constructor(bus: ObservabilityBus, directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(directory, 0o700)
    this.path = path.join(directory, `bootstrap-${process.pid}-${Date.now()}-${crypto.randomUUID()}.spool.ndjson`)
    this.fd = fs.openSync(this.path, "wx", 0o600)
    this.unsubscribe = bus.subscribe(
      (event) => this.capture(event),
      (event) => event.kind === "system.diagnostic" || event.kind === "system.model_catalog" || event.kind === "system.request_line",
      { name: "bootstrap-diagnostic-spool" },
    )
  }

  static attach(bus: ObservabilityBus, options: BootstrapSpoolOptions): BootstrapDiagnosticSpool {
    return new BootstrapDiagnosticSpool(bus, options.directory)
  }

  retireAndRead(): Array<StructuredFileRecord> {
    if (!this.retired) {
      this.retired = true
      this.unsubscribe()
      this.closeDurably()
    }
    const text = fs.readFileSync(this.path, "utf8")
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StructuredFileRecord)
  }

  closeDurably(): void {
    if (this.closed) return
    this.closed = true
    fs.fsyncSync(this.fd)
    fs.closeSync(this.fd)
  }

  removeDurably(): void {
    this.closeDurably()
    fs.rmSync(this.path, { force: true })
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
    if (record) fs.writeSync(this.fd, `${JSON.stringify(record)}\n`)
  }
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
