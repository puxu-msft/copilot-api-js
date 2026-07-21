/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 2 — length-prefixed JSON wire protocol shared by `uds-server.ts` (sidecar)
 * and `uds-client.ts` (main process). Pure, transport-agnostic framing: encode a
 * JSON value into one length-prefixed frame; incrementally decode a byte stream
 * (arbitrarily fragmented/coalesced by the OS) back into whole frames.
 *
 * Frame format: `[4-byte big-endian length][UTF-8 JSON body]`. Big-endian
 * (network byte order) is the conventional choice for wire length prefixes and
 * carries no platform-endianness ambiguity; JSON is human-inspectable (a debug
 * `nc -U` capture is directly readable past the 4 header bytes) and there is no
 * hot-path perf requirement here (one request/response per search query, not a
 * streaming hot path) that would justify a binary body encoding.
 *
 * The decoder is a plain synchronous reducer: feed it every `data` chunk exactly
 * as node:net delivers it (which may split a single JSON body across many `data`
 * events, or coalesce many frames into one) — it never assumes a `data` event
 * boundary lines up with a frame boundary, buffering underread and emitting every
 * frame it can complete from what has accumulated so far.
 */

const LENGTH_PREFIX_BYTES = 4
/** Guards against a malformed/hostile length prefix turning a bad connection into an
 *  unbounded memory allocation while buffering an incomplete frame. Generous relative
 *  to any real search request/response (queries and result sets are tiny strings). */
const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** Encode one JSON-serializable value into a single length-prefixed frame. */
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8")
  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`[history-search-uds] frame body ${body.byteLength} bytes exceeds ${MAX_FRAME_BYTES}-byte cap`)
  }
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES)
  header.writeUInt32BE(body.byteLength, 0)
  return Buffer.concat([header, body])
}

/**
 * Incremental frame decoder — a small stateful reducer, NOT tied to any socket.
 * `push(chunk)` accepts one arbitrarily-sized/fragmented byte chunk (as node:net
 * hands it over `data`) and returns every JSON value fully decoded so far (zero,
 * one, or many — a single chunk can complete several small frames at once, or
 * complete zero frames if it only advances a partial one).
 *
 * Deliberately does NOT throw when the accumulated bytes are simply incomplete
 * (the common, expected case for every partial chunk) — only a declared frame
 * length exceeding `MAX_FRAME_BYTES` or a body that fails to JSON.parse is a real
 * protocol violation, surfaced as a thrown error from `push` so the caller (the
 * connection owner) can decide how to react (never-throw belongs at the
 * transport-consumer layer, e.g. `uds-client.ts`'s query(), not here).
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Array<unknown> {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const decoded: Array<unknown> = []
    for (;;) {
      if (this.buffer.length < LENGTH_PREFIX_BYTES) break
      const length = this.buffer.readUInt32BE(0)
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`[history-search-uds] declared frame length ${length} exceeds ${MAX_FRAME_BYTES}-byte cap`)
      }
      const total = LENGTH_PREFIX_BYTES + length
      if (this.buffer.length < total) break // frame not fully arrived yet -- wait for more data
      const body = this.buffer.subarray(LENGTH_PREFIX_BYTES, total)
      this.buffer = this.buffer.subarray(total)
      decoded.push(JSON.parse(body.toString("utf8")))
    }
    return decoded
  }
}

/** Request the sidecar's search over the wire. */
export interface HistorySearchWireRequest {
  query: string
  operationKind?: string
  limit: number
}

/** A successful search response — `rows` carries the FULL `TantivySearchHit` shape
 *  (operationId/createdAt/score) untouched (richest-data-flow: the transport layer
 *  never trims fields). */
export interface HistorySearchWireResponse {
  rows: Array<{ operationId: string; createdAt: number; score: number }>
}

/** An error response — the sidecar's search() threw; carries a human-readable message. */
export interface HistorySearchWireError {
  error: string
}

export type HistorySearchWireReply = HistorySearchWireResponse | HistorySearchWireError

export function isWireError(reply: unknown): reply is HistorySearchWireError {
  return typeof reply === "object" && reply !== null && typeof (reply as { error?: unknown }).error === "string"
}
