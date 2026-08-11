/**
 * Gemini-shaped mapping for stream-lifecycle errors — the SINGLE source shared by the
 * live route handler (`src/routes/gemini/handler-v4.ts`) and the v4 codec's `formatError`
 * (`src/lib/codec/gemini/codec.ts`).
 *
 * It exists because those two used to keep private copies: the codec's copy knew that a
 * hard request deadline is `DEADLINE_EXCEEDED`, the live one did not and shipped `INTERNAL`.
 * Mirrors `~/lib/openai/stream-error`, which already had this shape and consequently did
 * NOT drift.
 */

import {
  //
  classifyStreamError,
  type StreamErrorKind,
} from "~/lib/stream"

/**
 * Canonical gRPC `status` for a classified stream-lifecycle kind.
 *
 * `Record` rather than a `switch` default so a new `StreamErrorKind` is a compile error
 * here instead of silently landing in the generic `INTERNAL` bucket.
 *
 * Grouping rationale: every clock WE run out reports `DEADLINE_EXCEEDED` — the frame-idle
 * watchdog, the hard request deadline, and the stale-request reaper (which is
 * `stale_request_max_age` expiring, i.e. a deadline). Cancellations report `CANCELLED`.
 * A lifecycle cancel with no recorded cause must NOT borrow a specific status, so it stays
 * `INTERNAL` alongside `other`.
 */
const GEMINI_STREAM_ERROR_STATUS: Record<StreamErrorKind, string> = {
  "idle-timeout": "DEADLINE_EXCEEDED",
  "request-deadline": "DEADLINE_EXCEEDED",
  "reaper-cancel": "DEADLINE_EXCEEDED",
  "client-abort": "CANCELLED",
  "request-cancel": "CANCELLED",
  "dispatch-cancel": "CANCELLED",
  "unknown-cancel": "INTERNAL",
  other: "INTERNAL",
}

/**
 * Google's canonical gRPC-status → HTTP-code table. Deriving the code from the status
 * (instead of picking it independently at each call site) is what keeps the two fields
 * from disagreeing — the live handler used to hardcode `shutdown ? 503 : 500`, which
 * would have paired `status:"DEADLINE_EXCEEDED"` with `code:500`.
 */
const GEMINI_STATUS_HTTP_CODE: Record<string, number> = {
  DEADLINE_EXCEEDED: 504,
  UNAVAILABLE: 503,
  CANCELLED: 499,
  INTERNAL: 500,
}

/** @see GEMINI_STREAM_ERROR_STATUS */
export function streamErrorKindToGeminiStatus(kind: StreamErrorKind): string {
  return GEMINI_STREAM_ERROR_STATUS[kind]
}

/** HTTP code for a Gemini gRPC status string (500 for anything unmapped). */
export function geminiStatusToHttpCode(status: string): number {
  return GEMINI_STATUS_HTTP_CODE[status] ?? 500
}

/** The `{ code, status }` pair for a classified stream-lifecycle kind — always consistent. */
export function geminiStreamErrorStatusAndCode(kind: StreamErrorKind): { code: number; status: string } {
  const status = streamErrorKindToGeminiStatus(kind)
  return { code: geminiStatusToHttpCode(status), status }
}

/**
 * `{ code, status }` for a raw stream error — the LIVE handler entry point.
 *
 * BOUNDARY OBSERVATION POINT: the kind-in variants above stay pure (the codec and unit tests call
 * them); this error-in wrapper runs once per failed stream on the live path, so it is the one place
 * that can count a provenance gap without double-counting. A non-zero counter means some producer
 * aborted without a cause tag — see `~/lib/observability/abort-provenance-gaps`.
 */
export function geminiStreamErrorFromError(error: unknown): { code: number; status: string } {
  const kind = classifyStreamError(error)
  return geminiStreamErrorStatusAndCode(kind)
}
