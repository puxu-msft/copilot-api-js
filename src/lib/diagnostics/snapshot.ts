import type {
  //
  DiagnosticError,
  DiagnosticValue,
} from "./types"

export interface SnapshotLimits {
  maxDepth: number
  maxBreadth: number
  maxStringBytes: number
  maxTotalBytes: number
}

const DEFAULT_LIMITS: SnapshotLimits = { maxDepth: 12, maxBreadth: 100, maxStringBytes: 16 * 1024, maxTotalBytes: 256 * 1024 }

interface SnapshotState {
  readonly limits: SnapshotLimits
  readonly seen: WeakSet<object>
  bytes: number
}

function tagged(type: "undefined" | "symbol" | "function" | "circular" | "truncated" | "unavailable", value?: string): DiagnosticValue {
  return value === undefined ? { $type: type } : { $type: type, value }
}

function safeString(value: string, state: SnapshotState): string | DiagnosticValue {
  const bytes = Buffer.byteLength(value)
  const remaining = Math.max(0, Math.min(state.limits.maxStringBytes, state.limits.maxTotalBytes - state.bytes))
  if (bytes <= remaining) {
    state.bytes += bytes
    return value
  }
  state.bytes += remaining
  return tagged("truncated", Buffer.from(value).subarray(0, remaining).toString("utf8"))
}

function snapshotObject(value: object, depth: number, state: SnapshotState): DiagnosticValue {
  if (state.seen.has(value)) return tagged("circular")
  if (depth >= state.limits.maxDepth || state.bytes >= state.limits.maxTotalBytes) return tagged("truncated")
  state.seen.add(value)
  try {
    if (value instanceof Date)
      return { $type: "date", value: snapshotUnknown(Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString(), depth + 1, state) }
    if (Buffer.isBuffer(value)) return { $type: "buffer", value: snapshotUnknown(value.toString("base64"), depth + 1, state) }
    if (ArrayBuffer.isView(value))
      return { $type: "typed-array", value: snapshotUnknown(Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)), depth + 1, state) }
    if (Array.isArray(value)) {
      const items = value.slice(0, state.limits.maxBreadth).map((item) => snapshotUnknown(item, depth + 1, state))
      if (value.length > items.length) items.push(tagged("truncated", `${value.length - items.length} items`))
      return { $type: "array", value: items }
    }
    if (value instanceof Map) return { $type: "map", value: snapshotUnknown(Array.from(value.entries()), depth + 1, state) }
    if (value instanceof Set) return { $type: "set", value: snapshotUnknown(Array.from(value), depth + 1, state) }

    const output = Object.create(null) as Record<string, DiagnosticValue>
    let count = 0
    for (const key of Reflect.ownKeys(value)) {
      if (count++ >= state.limits.maxBreadth) {
        Object.defineProperty(output, "$truncated", { value: tagged("truncated", "breadth"), enumerable: true })
        break
      }
      const name = typeof key === "symbol" ? `[${String(key)}]` : key
      let item: DiagnosticValue
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor?.get) item = tagged("unavailable", "getter")
        else item = snapshotUnknown(descriptor?.value, depth + 1, state)
      } catch (error) {
        item = tagged("unavailable", error instanceof Error ? error.message : String(error))
      }
      Object.defineProperty(output, name, { value: item, enumerable: true, configurable: false, writable: false })
    }
    return { $type: "object", value: output }
  } finally {
    state.seen.delete(value)
  }
}

function snapshotUnknown(value: unknown, depth: number, state: SnapshotState): DiagnosticValue {
  try {
    if (value === null) return null
    switch (typeof value) {
      case "boolean": {
        return value
      }
      case "string": {
        return safeString(value, state)
      }
      case "number": {
        if (Number.isNaN(value)) return { $type: "number", value: "NaN" }
        if (value === Number.POSITIVE_INFINITY) return { $type: "number", value: "Infinity" }
        if (value === Number.NEGATIVE_INFINITY) return { $type: "number", value: "-Infinity" }
        if (Object.is(value, -0)) return { $type: "number", value: "-0" }
        return value
      }
      case "bigint": {
        return { $type: "bigint", value: String(value) }
      }
      case "undefined": {
        return tagged("undefined")
      }
      case "symbol": {
        return tagged("symbol", value.description)
      }
      case "function": {
        return tagged("function", value.name || undefined)
      }
      case "object": {
        return snapshotObject(value, depth, state)
      }
      default: {
        return tagged("unavailable", typeof value)
      }
    }
  } catch (error) {
    return tagged("unavailable", error instanceof Error ? error.message : String(error))
  }
}

export function snapshotDiagnosticValue(value: unknown, limits: Partial<SnapshotLimits> = {}): DiagnosticValue {
  return snapshotUnknown(value, 0, { limits: { ...DEFAULT_LIMITS, ...limits }, seen: new WeakSet(), bytes: 0 })
}

function valueFromProjectedObject(value: DiagnosticValue, key: string): DiagnosticValue | undefined {
  return value && typeof value === "object" && "$type" in value && value.$type === "object" ? value.value[key] : undefined
}

function stringFromDiagnostic(value: DiagnosticValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function snapshotDiagnosticError(error: unknown): DiagnosticError | undefined {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return undefined
  const projected = snapshotDiagnosticValue(error)
  const name = stringFromDiagnostic(valueFromProjectedObject(projected, "name")) ?? (error instanceof Error ? error.name : "Error")
  const message = stringFromDiagnostic(valueFromProjectedObject(projected, "message")) ?? (error instanceof Error ? error.message : "Unknown error")
  const stack = stringFromDiagnostic(valueFromProjectedObject(projected, "stack")) ?? (error instanceof Error ? error.stack : undefined)
  const cause = valueFromProjectedObject(projected, "cause")
  const codeValue = valueFromProjectedObject(projected, "code")
  const statusValue = valueFromProjectedObject(projected, "status") ?? valueFromProjectedObject(projected, "statusCode")
  return {
    name,
    message,
    ...(stack && { stack }),
    ...(cause !== undefined && { cause }),
    ...((typeof codeValue === "string" || typeof codeValue === "number") && { code: codeValue }),
    ...(typeof statusValue === "number" && { status: statusValue }),
    ...(projected && typeof projected === "object" && "$type" in projected && projected.$type === "object" && { fields: projected.value }),
  }
}

export function deepFreezeDiagnostic<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value as Record<string, unknown>)) deepFreezeDiagnostic(item)
  return value
}
