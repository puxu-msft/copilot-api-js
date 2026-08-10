import type { ClientFrame } from "./types"

/** Actual client-visible SSE fields emitted by {@link encodeSseFrame}. */
export type SseWireProjection = Readonly<{
  event?: string
  data: string
  id?: string
  retry?: number
}>

export interface EncodedSseFrame {
  readonly bytes: Uint8Array
  readonly projection: SseWireProjection
}

const normalizeDataValue = (value: string): string => value.replaceAll(/\r\n|\r/g, "\n")

/** WHATWG applies only the final event/id field, so client-visible values must be one legal line. */
const normalizeSingleLineField = (value: string): string => value.replaceAll(/\r\n|\r|\n/g, " ")

function encodeData(value: string): string {
  return normalizeDataValue(value)
    .split("\n")
    .map((line) => `data:${line.length > 0 ? ` ${line}` : ""}\n`)
    .join("")
}

function encodeSingleLineField(name: "event" | "id", value: string): string {
  return `${name}:${value.length > 0 ? ` ${value}` : ""}\n`
}

/** Encode one wire-only client frame exactly once for both transport bytes and History projection. */
export function encodeSseFrame(frame: ClientFrame): EncodedSseFrame {
  const id = frame.id === undefined ? undefined : String(frame.id)
  if (id?.includes("\0")) throw new TypeError("SSE id must not contain U+0000")
  if (frame.retry !== undefined && (!Number.isSafeInteger(frame.retry) || frame.retry < 0)) throw new TypeError("SSE retry must be a non-negative safe integer")
  const projection = Object.freeze({
    ...(frame.event !== undefined && { event: normalizeSingleLineField(frame.event) }),
    data: normalizeDataValue(frame.data ?? ""),
    ...(id !== undefined && { id: normalizeSingleLineField(id) }),
    ...(frame.retry !== undefined && { retry: frame.retry }),
  })
  const text =
    (projection.event !== undefined ? encodeSingleLineField("event", projection.event) : "")
    + encodeData(projection.data)
    + (projection.id !== undefined ? encodeSingleLineField("id", projection.id) : "")
    + (projection.retry !== undefined ? `retry: ${projection.retry}\n` : "")
    + "\n"
  return Object.freeze({ bytes: new TextEncoder().encode(text), projection })
}
