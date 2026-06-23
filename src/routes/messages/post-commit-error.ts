/**
 * POST-COMMIT error-frame synthesis for the Anthropic ③ pre-response-grace path (RFC §4.2.5).
 *
 * Once ③ commits a 200 SSE stream (grace elapsed, upstream still silent), the HTTP status is
 * locked — any subsequent upstream failure can only be delivered as an Anthropic `event: error`
 * SSE frame. These pure builders synthesize that frame while preserving the canonical `error.type`
 * (+ `retry_after` for rate limits) so the client SDK can still branch correctly (Q2 oracle: the
 * `error.type` literal IS what Claude Code / the Anthropic SDK display + branch on — see
 * exp/q2-oracle/REPORT.md). They are unit-tested in isolation here; the C3b COMMIT dispatch wires them.
 *
 * Discrimination uses SIGNAL STATE, never `error.name`: a pre-response client-abort, a stale-reaper
 * cancel, and a header-wait timeout are ALL synthesized by the http2 client as a generic AbortError
 * (the signal reason is discarded), and a pre-response reaper-cancel is a plain AbortError — NOT a
 * `StreamReaperCancelError` (that type only exists inside the stream-drain guard). See RFC §4.2.1.
 */

import type { ClientFrame } from "~/lib/pipeline/types"

import {
  //
  type ErrorWireFormat,
  HTTPError,
  mapHttpErrorToEnvelope,
} from "~/lib/error"

const ANTHROPIC: ErrorWireFormat = "anthropic"

/** Canonical Anthropic `error.type` for an HTTP status, for the unclassified (default-path) cases
 *  forwardError doesn't already map (401/403/404/generic). The SDK branches on this literal (Q2). */
function anthropicErrorTypeForStatus(status: number): string {
  switch (status) {
    case 400: {
      return "invalid_request_error"
    }
    case 401: {
      return "authentication_error"
    }
    case 403: {
      return "permission_error"
    }
    case 404: {
      return "not_found_error"
    }
    case 413: {
      return "request_too_large"
    }
    case 429: {
      return "rate_limit_error"
    }
    case 529: {
      return "overloaded_error"
    }
    default: {
      return status >= 500 ? "api_error" : "invalid_request_error"
    }
  }
}

/**
 * Reshape a {@link mapHttpErrorToEnvelope} `body` into VALID Anthropic SSE `error` event data.
 * The classified branches (429/413/402/422/503/…) already emit canonical
 * `{ type:"error", error:{ type, message, retry_after? } }` (verbatim SSE data) → pass through.
 * The DEFAULT branch emits the mis-shaped `{ error:{ message, type:"error" } }` (no top-level `type`,
 * inner `error.type` is the literal "error", `error.message` carries the raw upstream body) — reshape
 * it to a canonical envelope with the status-derived `error.type` so a client SDK can branch on it.
 */
export function toAnthropicSseErrorData(body: Record<string, unknown>, status: number, classified: boolean): Record<string, unknown> {
  if (classified) return body
  const inner = (body.error ?? {}) as { message?: unknown }
  const message = typeof inner.message === "string" ? inner.message : "upstream error"
  return { type: "error", error: { type: anthropicErrorTypeForStatus(status), message } }
}

/** Build the Anthropic SSE `error` frame for a POST-COMMIT upstream {@link HTTPError} — reuses
 *  {@link mapHttpErrorToEnvelope} so classified errors keep `error.type` + `retry_after` (§4.2.5). */
export function anthropicHttpErrorFrame(error: HTTPError): ClientFrame {
  const { body, status, classified } = mapHttpErrorToEnvelope(error, ANTHROPIC)
  return { event: "error", data: JSON.stringify(toAnthropicSseErrorData(body, status, classified)) }
}

/** Build the Anthropic SSE `error` frame for a `decideRoute` reject (no HTTPError object, only
 *  `{status, reason}`) — synthesize an HTTPError so the shared {@link anthropicHttpErrorFrame}
 *  path applies (the reject `reason` is the message). */
export function anthropicRejectErrorFrame(status: number, reason: string): ClientFrame {
  return anthropicHttpErrorFrame(new HTTPError(reason, status, reason))
}

/** Build an Anthropic SSE `error` frame from an explicit type+message (header-wait timeout,
 *  reaper-cancel, or an unknown non-HTTP error) — not an HTTPError, so hand-built canonical. */
export function anthropicErrorFrame(type: string, message: string): ClientFrame {
  return { event: "error", data: JSON.stringify({ type: "error", error: { type, message } }) }
}

/** A POST-COMMIT abort classified by SIGNAL STATE (precedence: client > reaper > timeout). */
export type PostCommitAbortKind = "client-abort" | "reaper-cancel" | "timeout"

/**
 * Discriminate a POST-COMMIT abort by which controller flipped — NEVER by `error.name` (all three
 * are generic AbortErrors, §4.2.1). Client-abort wins (round-2 H-1: the client is gone, no reader);
 * then reaper-cancel (stale-request reaper aborted the in-flight upstream); else a header-wait timeout.
 */
export function classifyPostCommitAbort(clientAborted: boolean, reaperAborted: boolean): PostCommitAbortKind {
  if (clientAborted) return "client-abort"
  if (reaperAborted) return "reaper-cancel"
  return "timeout"
}
