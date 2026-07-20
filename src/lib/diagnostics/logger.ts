import type { ScopedPublisher } from "~/lib/observability"

import type {
  //
  DiagnosticEvent,
  DiagnosticLevel,
  DiagnosticValue,
} from "./types"

import { writeEmergencyFallback } from "./emergency-output"
import { createDiagnosticEvent } from "./event"
import { redactDiagnosticFields } from "./redaction"
import {
  //
  deepFreezeDiagnostic,
  snapshotDiagnosticValue,
} from "./snapshot"

export interface DiagnosticBindings {
  scope?: ReadonlyArray<string>
  correlation?: DiagnosticEvent["correlation"]
  fields?: Readonly<Record<string, unknown>>
}

export interface DiagnosticLogger {
  child(bindings: DiagnosticBindings): DiagnosticLogger
  emit(level: DiagnosticLevel, event: string, message: string, fields?: Readonly<Record<string, unknown>>, error?: unknown): void
  trace(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void
  debug(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void
  info(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void
  warn(event: string, message: string, fields?: Readonly<Record<string, unknown>>, error?: unknown): void
  error(event: string, message: string, fields?: Readonly<Record<string, unknown>>, error?: unknown): void
}

interface FrozenBindings {
  scope: ReadonlyArray<string>
  correlation?: DiagnosticEvent["correlation"]
  fields: Readonly<Record<string, DiagnosticValue>>
}

class Logger implements DiagnosticLogger {
  private readonly publisher: ScopedPublisher<"system"> | undefined
  private readonly bindings: FrozenBindings

  constructor(publisher: ScopedPublisher<"system"> | undefined, bindings: FrozenBindings) {
    this.publisher = publisher
    this.bindings = bindings
  }

  child(bindings: DiagnosticBindings): DiagnosticLogger {
    const next = freezeBindings(bindings)
    return new Logger(this.publisher, {
      scope: [...this.bindings.scope, ...next.scope],
      correlation: { ...this.bindings.correlation, ...next.correlation },
      fields: deepFreezeDiagnostic({ ...this.bindings.fields, ...next.fields }),
    })
  }

  emit(level: DiagnosticLevel, event: string, message: string, fields?: Readonly<Record<string, unknown>>, error?: unknown): void {
    try {
      const diagnostic = createDiagnosticEvent({
        level,
        scope: this.bindings.scope,
        event,
        message,
        projectedFields: this.bindings.fields,
        fields,
        correlation: this.bindings.correlation,
        ...(error !== undefined && { error }),
        origin: "native",
      })
      if (this.publisher) this.publisher.publish({ kind: "system.diagnostic", diagnostic })
      else writeEmergencyFallback(`[${diagnostic.severity}] ${diagnostic.scope.join("/") || "process"}: ${diagnostic.message}`)
    } catch {
      writeEmergencyFallback("[diagnostics] logger projection failed")
    }
  }

  trace(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("trace", event, message, fields)
  }
  debug(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("debug", event, message, fields)
  }
  info(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("info", event, message, fields)
  }
  warn(event: string, message: string, fields?: Readonly<Record<string, unknown>>, error?: unknown): void {
    this.emit("warn", event, message, fields, error)
  }
  error(event: string, message: string, fields?: Readonly<Record<string, unknown>>, error?: unknown): void {
    this.emit("error", event, message, fields, error)
  }
}

function freezeBindings(bindings: DiagnosticBindings): FrozenBindings {
  const fields = Object.create(null) as Record<string, DiagnosticValue>
  for (const [key, value] of Object.entries(bindings.fields ?? {})) fields[key] = snapshotDiagnosticValue(value)
  return deepFreezeDiagnostic({
    scope: [...(bindings.scope ?? [])],
    ...(bindings.correlation !== undefined && { correlation: { ...bindings.correlation } }),
    fields: redactDiagnosticFields(fields),
  })
}

export function createDiagnosticLogger(publisher?: ScopedPublisher<"system">, bindings: DiagnosticBindings = {}): DiagnosticLogger {
  return new Logger(publisher, freezeBindings(bindings))
}

let rootLogger: DiagnosticLogger = createDiagnosticLogger()

export function initDiagnosticLogger(publisher: ScopedPublisher<"system">): DiagnosticLogger {
  rootLogger = createDiagnosticLogger(publisher)
  return rootLogger
}

export function getDiagnosticLogger(): DiagnosticLogger {
  return rootLogger
}

export function resetDiagnosticLoggerForTests(): void {
  rootLogger = createDiagnosticLogger()
}
