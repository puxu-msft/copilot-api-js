import type { ProcessIdentity } from "~/lib/process-identity"

export type DiagnosticLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

export type DiagnosticValue =
  | null
  | boolean
  | string
  | number
  | { readonly $type: "number"; readonly value: "NaN" | "Infinity" | "-Infinity" | "-0" }
  | { readonly $type: "bigint"; readonly value: string }
  | { readonly $type: "array"; readonly value: ReadonlyArray<DiagnosticValue> }
  | { readonly $type: "object"; readonly value: Readonly<Record<string, DiagnosticValue>> }
  | { readonly $type: "date" | "buffer" | "typed-array" | "map" | "set"; readonly value: DiagnosticValue }
  | { readonly $type: "undefined" | "symbol" | "function" | "circular" | "truncated" | "unavailable"; readonly value?: string }

export interface DiagnosticError {
  readonly name: string
  readonly message: string
  readonly stack?: string
  readonly cause?: DiagnosticValue
  readonly code?: string | number
  readonly status?: number
  readonly fields?: Readonly<Record<string, DiagnosticValue>>
}

export interface DiagnosticEvent {
  readonly schemaVersion: 1
  readonly timeUnixMs: number
  readonly severity: DiagnosticLevel
  readonly scope: ReadonlyArray<string>
  readonly event: string
  readonly message: string
  readonly correlation?: {
    readonly requestId?: string
    readonly sessionId?: string
    readonly attemptIndex?: number
    readonly transport?: string
  }
  readonly process: Readonly<ProcessIdentity>
  readonly fields: Readonly<Record<string, DiagnosticValue>>
  readonly error?: DiagnosticError
  readonly origin: "native" | "consola-adapter"
}
