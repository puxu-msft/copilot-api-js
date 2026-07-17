import type { DiagnosticValue } from "./types"

const SECRET_KEY = /access[_-]?token|authorization|cookie|device[_-]?code|refresh[_-]?token|api[_-]?key|password|secret/i
const SECRET_VALUE = /\b(?:Bearer\s+\S+|gh[opusr]_\w+|github_pat_\w+)\b/gi

const REDACTED = "[REDACTED]"

function redactString(value: string): string {
  return value.replaceAll(SECRET_VALUE, REDACTED)
}

export function redactDiagnosticValue(value: DiagnosticValue, logicalKey?: string): DiagnosticValue {
  if (logicalKey && SECRET_KEY.test(logicalKey)) return REDACTED
  if (typeof value === "string") return redactString(value)
  if (!value || typeof value !== "object" || !("$type" in value)) return value
  switch (value.$type) {
    case "array": {
      return { ...value, value: value.value.map((item) => redactDiagnosticValue(item)) }
    }
    case "object": {
      const output = Object.create(null) as Record<string, DiagnosticValue>
      for (const [key, item] of Object.entries(value.value)) {
        Object.defineProperty(output, key, { value: redactDiagnosticValue(item, key), enumerable: true, configurable: false, writable: false })
      }
      return { ...value, value: output }
    }
    case "date":
    case "buffer":
    case "typed-array":
    case "map":
    case "set": {
      return { ...value, value: redactDiagnosticValue(value.value) }
    }
    default: {
      return value
    }
  }
}

export function redactDiagnosticFields(fields: Record<string, DiagnosticValue>): Record<string, DiagnosticValue> {
  const output = Object.create(null) as Record<string, DiagnosticValue>
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(output, key, { value: redactDiagnosticValue(value, key), enumerable: true, configurable: false, writable: false })
  }
  return output
}

export function redactDiagnosticText(text: string): string {
  return redactString(text)
}
