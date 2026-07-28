/**
 * POST-COMMIT error-frame synthesis for the Anthropic delayed-commit streaming path
 * (③ in docs/spec/pre-response-abort-handling.md §4.2.5 — the mechanism lives on, renamed from the
 * old "grace" knob to the `streamCommitAfterSec` window).
 *
 * Once the proxy commits a 200 SSE stream (the delayed-commit window elapsed with the upstream
 * still silent), the HTTP status is locked — any subsequent upstream failure can only be delivered
 * as an Anthropic `event: error`
 * SSE frame. These pure builders synthesize that frame while preserving the canonical `error.type`
 * (+ `retry_after` for rate limits) so the client SDK can still branch correctly (Q2 oracle: the
 * `error.type` literal IS what Claude Code / the Anthropic SDK display + branch on — see
 * exp/q2-oracle/REPORT.md). They are unit-tested in isolation here; the C3b COMMIT dispatch wires them.
 *
 * Discrimination is EVIDENCE-BASED: the abort's own reason (`TimeoutError` identity for the
 * response-header watchdog, the `pool-closed` transport tag, the cancellation-cause tag carried by
 * `ctx.cancel` / the reaper / a dispatch teardown) decides the kind, with signal state as the
 * fallback for aborts nobody tagged. It used to be signal-state ONLY — because the http2 client
 * discarded the signal reason, every cause arrived as one indistinguishable generic AbortError —
 * which meant a hard-deadline cancellation was reported to the client as a stale-reaper cancel.
 * See RFC §4.2.1 and `~/lib/error/cancellation-reason`.
 */

import type { ClientFrame } from "~/lib/pipeline/types"

import {
  //
  type ErrorWireFormat,
  HTTPError,
  mapHttpErrorToEnvelope,
} from "~/lib/error"
import { getCancellationCause } from "~/lib/error/cancellation-reason"
import { isShutdownCausedAbort } from "~/lib/shutdown"

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

/** A POST-COMMIT abort, classified by the abort's own provenance (signal state is the fallback). */
export type PostCommitAbortKind =
  | "client-abort"
  | "shutdown"
  | "header-timeout"
  | "request-deadline"
  | "reaper-cancel"
  | "request-cancel"
  | "dispatch-cancel"
  | "unknown-abort"

/** The terminal SSE error-frame message for each abort kind (`client-abort` writes nothing — the client is gone). */
const POST_COMMIT_ABORT_MESSAGE: Record<Exclude<PostCommitAbortKind, "client-abort">, string> = {
  shutdown: "Server is shutting down",
  "header-timeout": "Upstream timed out before sending response headers",
  "request-deadline": "Request exceeded its hard deadline",
  "reaper-cancel": "Request cancelled by the stale-request reaper",
  "request-cancel": "Request cancelled",
  "dispatch-cancel": "Upstream dispatch cancelled",
  "unknown-abort": "Request aborted (no cause recorded)",
}

/** Terminal `event: error` frame for a post-commit abort of `kind`. */
export function postCommitAbortFrame(kind: Exclude<PostCommitAbortKind, "client-abort">): ClientFrame {
  return anthropicErrorFrame("api_error", POST_COMMIT_ABORT_MESSAGE[kind])
}

/**
 * Discriminate a POST-COMMIT abort. Evidence first, signal state only as a fallback:
 *
 * 1. `clientAborted` — the client is gone; nothing else matters, there is no reader left.
 * 2. shutdown provenance (Phase 3 abort reason identity / `pool-closed` transport tag).
 * 3. `TimeoutError` — the response-header watchdog itself fired (`AbortSignal.timeout`).
 * 4. the cancellation-cause tag — hard deadline vs stale reaper vs explicit cancel vs
 *    dispatch teardown.
 * 5. fallback: `reaperAborted` (the request's lifecycle signal fired but nobody tagged the
 *    reason) → reaper-cancel.
 * 6. nothing at all → `unknown-abort`. It deliberately does NOT default to a header
 *    timeout: naming a cause we cannot evidence is the exact failure this classifier
 *    exists to end (a 609ms request once shipped as a 900s header timeout), and it
 *    mirrors what `forwardError` does pre-commit. An `unknown-abort` in the wild is a
 *    signal in its own right — some path is not carrying its provenance yet.
 */
export function classifyPostCommitAbort(clientAborted: boolean, reaperAborted: boolean, error?: unknown): PostCommitAbortKind {
  if (clientAborted) return "client-abort"
  if (error !== undefined) {
    if (isShutdownCausedAbort(error)) return "shutdown"
    if (error instanceof Error && error.name === "TimeoutError") return "header-timeout"
    const cause = getCancellationCause(error)
    if (cause === "request-deadline") return "request-deadline"
    if (cause === "stale-reaper") return "reaper-cancel"
    if (cause === "request-cancel") return "request-cancel"
    if (cause === "dispatch-cancel") return "dispatch-cancel"
  }
  if (reaperAborted) return "reaper-cancel"
  return "unknown-abort"
}
