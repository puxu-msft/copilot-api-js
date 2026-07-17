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
  redactDiagnosticError,
  redactDiagnosticFields,
  redactDiagnosticText,
  redactDiagnosticValue,
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
  const error = input.error === undefined ? undefined : snapshotDiagnosticError(input.error)
  const event: DiagnosticEvent = {
    schemaVersion: 1,
    timeUnixMs: input.timeUnixMs ?? Date.now(),
    severity: input.level,
    scope: [...(input.scope ?? [])],
    event: input.event,
    message: redactDiagnosticText(input.message),
    process: { ...getProcessIdentityQuiet() },
    fields: snapshotFields(input),
    ...(error !== undefined && { error: redactDiagnosticError(error) }),
    origin: input.origin,
  }
  return deepFreezeDiagnostic(event)
}

/** Human fallback used only after snapshot and redaction have completed. */
export function diagnosticValueText(value: DiagnosticValue): string {
  if (typeof value === "string") return value
  return stringify(toHumanValue(value)) ?? "[Unavailable diagnostic value]"
}

export function projectDiagnosticArgument(value: unknown): string {
  if (isErrorLike(value)) {
    const error = snapshotDiagnosticError(value)
    if (error) {
      const redacted = redactDiagnosticError(error)
      return redacted.stack ?? redacted.message
    }
  }
  return diagnosticValueText(redactDiagnosticValue(snapshotDiagnosticValue(value)))
}

function isErrorLike(value: unknown): boolean {
  if (value instanceof Error) return true
  if (!value || typeof value !== "object") return false
  try {
    const keys = Reflect.ownKeys(value)
    return keys.includes("message") && (keys.includes("name") || keys.includes("stack"))
  } catch {
    return false
  }
}

function toHumanValue(value: DiagnosticValue): unknown {
  if (!value || typeof value !== "object" || !("$type" in value)) return value
  switch (value.$type) {
    case "array": {
      return value.value.map(toHumanValue)
    }
    case "object": {
      return Object.fromEntries(Object.entries(value.value).map(([key, item]) => [key, toHumanValue(item)]))
    }
    case "bigint": {
      return `${value.value}n`
    }
    case "date":
    case "buffer":
    case "typed-array":
    case "map":
    case "set": {
      return toHumanValue(value.value)
    }
    default: {
      return value.value === undefined ? `[${value.$type}]` : `[${value.$type}: ${value.value}]`
    }
  }
}

export function diagnosticConsolaType(event: { severity: string; fields?: DiagnosticEvent["fields"] }): string {
  const value = event.fields?.consolaType
  return typeof value === "string" ? value : event.severity
}
