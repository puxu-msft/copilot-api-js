import stringify from "safe-stable-stringify"

import { getProcessIdentityQuiet } from "~/lib/process-identity"

import type {
  //
  DiagnosticEvent,
  DiagnosticLevel,
  DiagnosticValue,
} from "./types"

import {
  //
  redactDiagnosticFields,
  redactDiagnosticText,
} from "./redaction"
import {
  //
  deepFreezeDiagnostic,
  snapshotDiagnosticError,
  snapshotDiagnosticValue,
} from "./snapshot"

export interface DiagnosticEventInput {
  level: DiagnosticLevel
  scope?: ReadonlyArray<string>
  event: string
  message: string
  args?: ReadonlyArray<unknown>
  fields?: Readonly<Record<string, unknown>>
  error?: unknown
  timeUnixMs?: number
  origin: "native" | "consola-adapter"
}

function snapshotFields(input: DiagnosticEventInput): Record<string, DiagnosticValue> {
  const fields = Object.create(null) as Record<string, DiagnosticValue>
  for (const [key, value] of Object.entries(input.fields ?? {})) fields[key] = snapshotDiagnosticValue(value)
  if (input.args && input.args.length > 0) fields.args = snapshotDiagnosticValue(input.args)
  return redactDiagnosticFields(fields)
}

export function createDiagnosticEvent(input: DiagnosticEventInput): DiagnosticEvent {
  const event: DiagnosticEvent = {
    schemaVersion: 1,
    timeUnixMs: input.timeUnixMs ?? Date.now(),
    severity: input.level,
    scope: [...(input.scope ?? [])],
    event: input.event,
    message: redactDiagnosticText(input.message),
    process: { ...getProcessIdentityQuiet() },
    fields: snapshotFields(input),
    ...(input.error !== undefined && { error: snapshotDiagnosticError(input.error) }),
    origin: input.origin,
  }
  return deepFreezeDiagnostic(event)
}

/** Human fallback used only after snapshot and redaction have completed. */
export function diagnosticValueText(value: DiagnosticValue): string {
  if (typeof value === "string") return value
  return stringify(value)
}

export function diagnosticConsolaType(event: { severity: string; fields?: DiagnosticEvent["fields"] }): string {
  const value = event.fields?.consolaType
  return typeof value === "string" ? value : event.severity
}
