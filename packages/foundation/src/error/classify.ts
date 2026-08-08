import { HTTPError } from "./http-error"
import {
  //
  extractRetryAfterFromBody,
  extractTokenLimitFromResponseText,
  isUpstreamRateLimited,
} from "./parsing"
import { getTransportErrorReason } from "./transport-reason"
import {
  //
  formatErrorWithCause,
  parseRetryAfterHeader,
} from "./utils"

/** Structured error types for pipeline retry decisions */
export type ApiErrorType =
  | "rate_limited" // 429
  | "payload_too_large" // 413
  | "token_limit" // 200/400 but body contains token limit error
  | "content_filtered" // 422 — Responsible AI Service filtering
  | "quota_exceeded" // 402 — free tier / premium quota exceeded
  | "auth_expired" // Token expired
  | "network_error" // Retryable transport failure, including an empty upstream 499 or GHC request-body read timeout
  | "aborted" // Operation cancelled via AbortSignal (shutdown, client cancel, internal timeout)
  | "server_error" // 5xx (non-503-upstream)
  | "upstream_rate_limited" // 503 — upstream provider rate limited
  | "bad_request" // 400 (non-token-limit)

/** Classified API error with structured metadata */
export interface ApiError {
  type: ApiErrorType
  status: number
  message: string
  /** Retry-After seconds (rate_limited / quota_exceeded / upstream_rate_limited) */
  retryAfter?: number
  /** Token limit from error response (token_limit) */
  tokenLimit?: number
  /** Current token count from error response (token_limit) */
  tokenCurrent?: number
  /** Original response headers (for quota snapshots, etc.) */
  responseHeaders?: Headers
  /** Original error object */
  raw: unknown
}

/**
 * Classify a raw error into a structured ApiError.
 * Used by the pipeline to route errors to appropriate RetryStrategies.
 */
export function classifyError(error: unknown): ApiError {
  if (error instanceof HTTPError) {
    return classifyHTTPError(error)
  }

  // Aborts (client cancel, shutdown signal, internal timeout watchdogs) must
  // be classified separately from network errors. They share message keywords
  // ("aborted", "abort") but have opposite retry semantics: a real network
  // glitch warrants a retry; an abort means the caller no longer wants the
  // result. Classify aborts first so they bypass the network_error pattern
  // match below.
  if (error instanceof Error && isAbortError(error)) {
    return {
      type: "aborted",
      status: 0,
      message: formatErrorWithCause(error),
      raw: error,
    }
  }

  // HTTP/2 transport errors carry a STRUCTURED reason tag set by the producer
  // (http2-client.ts), which is authoritative and EXHAUSTIVE: when a tag is
  // present, it — never the substring fallback below — decides the classification,
  // so a real (tagged) error can never be re-classified by a coincidental string
  // overlap. `pre-response-close` (connection died before any response header —
  // reconnect is the only path to a usable response) and `refused-stream` (RFC
  // 9113 §8.7 zero-processing guarantee) are safely retryable → network_error →
  // the existing network-retry strategy (hasRetried latch bounds it to one
  // retry). `mid-body-close` (a truncated body after headers) is NOT retryable —
  // it terminates as bad_request here rather than falling through. The substring
  // checks BELOW are a defense-in-depth fallback ONLY for errors that reach
  // classify WITHOUT a tag (an untagged path, or a layer that re-wraps and drops
  // the tag).
  if (error instanceof Error) {
    const reason = getTransportErrorReason(error)
    if (reason !== undefined) {
      switch (reason) {
        case "pre-response-close":
        case "refused-stream": {
          return { type: "network_error", status: 0, message: formatErrorWithCause(error), raw: error }
        }
        case "mid-body-close": {
          // Truncated body after headers — never a pre-response retry. Terminal.
          return { type: "bad_request", status: 0, message: formatErrorWithCause(error), raw: error }
        }
        case "pool-closed": {
          // Our own session pool went away (shutdown force-close / finalize). It is a
          // CANCELLATION, so it classifies like every other abort — an in-process retry
          // would only hit the same closed pool. Reached only if a producer ever tags
          // `pool-closed` onto an error that is NOT AbortError-named: the isAbortError
          // branch above wins for the ones http2-client currently produces. Kept explicit
          // (not folded into `default`) so the exhaustiveness guard keeps its teeth.
          return { type: "aborted", status: 0, message: formatErrorWithCause(error), raw: error }
        }
        default: {
          // Exhaustiveness: a new TransportErrorReason must add its case above.
          const _never: never = reason
          return _never
        }
      }
    }
  }

  // HTTP/2 REFUSED_STREAM (substring FALLBACK — tag preferred above): the peer
  // refused the stream BEFORE performing any application processing (RFC 9113
  // §5.1.2 & §8.7). The protocol GUARANTEES the request was not processed, so
  // retry is safe even for a non-idempotent POST — unlike a generic 5xx or a
  // mid-stream NGHTTP2_CANCEL / NGHTTP2_INTERNAL_ERROR (which MAY have been
  // partially processed). Classified as network_error so the existing
  // network-retry strategy retries once on a fresh h2 session.
  if (error instanceof Error && isRetryableHttp2StreamError(error)) {
    return {
      type: "network_error",
      status: 0,
      message: formatErrorWithCause(error),
      raw: error,
    }
  }

  // HTTP/2 pre-response teardown (substring FALLBACK — tag preferred above): the
  // h2 stream/session died BEFORE any response headers arrived (status 0, zero
  // frames — http2-client.ts's `!headersReceived` close backstop). Semantically
  // DISTINCT from REFUSED_STREAM (which carries a protocol zero-processing
  // guarantee): here the connection is simply dead, and reconnecting + resending
  // is the ONLY way to deliver any usable response — not retrying just yields
  // "quota maybe already spent AND zero response". If the upstream had metered the
  // request before the teardown, it is recorded twice (inherent, unavoidable;
  // History/telemetry record it faithfully). The network-retry strategy's
  // `hasRetried` latch bounds the extra attempt to at most one.
  if (error instanceof Error && isRetryablePreResponseHttp2Close(error)) {
    return {
      type: "network_error",
      status: 0,
      message: formatErrorWithCause(error),
      raw: error,
    }
  }

  // Network errors: fetch failures, socket closures, connection resets, timeouts, DNS failures
  // Bun throws TypeError for some fetch failures, and plain Error for socket closures.
  // Match broadly on error message patterns to catch all network-level failures.
  if (error instanceof Error && isNetworkError(error)) {
    return {
      type: "network_error",
      status: 0,
      message: formatErrorWithCause(error),
      raw: error,
    }
  }

  if (error instanceof Error) {
    return {
      type: "bad_request",
      status: 0,
      message: formatErrorWithCause(error),
      raw: error,
    }
  }

  return {
    type: "bad_request",
    status: 0,
    message: String(error),
    raw: error,
  }
}

function classifyHTTPError(error: HTTPError): ApiError {
  const { status, responseText, message } = error

  // GHC accepted the HTTP/2 stream but its edge timed out while reading the request body. This is a transient upload/transport failure rather than an application-level rejection: replaying the unchanged request once is the only path to a response. Match both the structured code and the specific message so unrelated 408 deadlines remain terminal.
  if (status === 408 && isRequestBodyReadTimeout(responseText)) {
    return {
      type: "network_error",
      status,
      message,
      responseHeaders: error.responseHeaders,
      raw: error,
    }
  }

  // An upstream 499 with no body carries no actionable rejection detail. Treat it like a pre-response transport failure so the shared network strategy retries it once.
  // A non-empty 499 remains a terminal bad_request below because its body may describe an intentional cancellation that must not be replayed.
  if (status === 499 && responseText.trim() === "") {
    return {
      type: "network_error",
      status,
      message,
      responseHeaders: error.responseHeaders,
      raw: error,
    }
  }

  if (status === 422) {
    return {
      type: "content_filtered",
      status,
      message,
      responseHeaders: error.responseHeaders,
      raw: error,
    }
  }

  if (status === 402) {
    const retryAfter = extractRetryAfterFromBody(responseText) ?? parseRetryAfterHeader(error.responseHeaders)
    return {
      type: "quota_exceeded",
      status,
      message,
      retryAfter,
      responseHeaders: error.responseHeaders,
      raw: error,
    }
  }

  if (status === 429) {
    const retryAfter = extractRetryAfterFromBody(responseText) ?? parseRetryAfterHeader(error.responseHeaders)
    return {
      type: "rate_limited",
      status,
      message,
      retryAfter,
      responseHeaders: error.responseHeaders,
      raw: error,
    }
  }

  if (status === 413) {
    return {
      type: "payload_too_large",
      status,
      message,
      responseHeaders: error.responseHeaders,
      raw: error,
    }
  }

  if (status === 503) {
    const retryAfter = extractRetryAfterFromBody(responseText) ?? parseRetryAfterHeader(error.responseHeaders)
    if (isUpstreamRateLimited(responseText)) {
      return {
        type: "upstream_rate_limited",
        status,
        message,
        retryAfter,
        responseHeaders: error.responseHeaders,
        raw: error,
      }
    }
    return {
      type: "server_error",
      status,
      message,
      retryAfter,
      responseHeaders: error.responseHeaders,
      raw: error,
    }
  }

  if (status >= 500) {
    return {
      type: "server_error",
      status,
      message,
      responseHeaders: error.responseHeaders,
      raw: error,
    }
  }

  if (status === 401 || status === 403) {
    return {
      type: "auth_expired",
      status,
      message,
      responseHeaders: error.responseHeaders,
      raw: error,
    }
  }

  if (status === 400) {
    const tokenLimit = tryExtractTokenLimit(responseText)
    if (tokenLimit) {
      return {
        type: "token_limit",
        status,
        message,
        tokenLimit: tokenLimit.limit,
        tokenCurrent: tokenLimit.current,
        responseHeaders: error.responseHeaders,
        raw: error,
      }
    }

    if (isRateLimitedInBody(responseText)) {
      const retryAfter = extractRetryAfterFromBody(responseText) ?? parseRetryAfterHeader(error.responseHeaders)
      return {
        type: "rate_limited",
        status,
        message,
        retryAfter,
        responseHeaders: error.responseHeaders,
        raw: error,
      }
    }
  }

  return {
    type: "bad_request",
    status,
    message,
    responseHeaders: error.responseHeaders,
    raw: error,
  }
}

/** Match the structured GHC error for a timeout while reading our request body. */
function isRequestBodyReadTimeout(responseText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(responseText)
    if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return false
    const error = (parsed as { error: unknown }).error
    if (!error || typeof error !== "object") return false
    const { code, message } = error as { code?: unknown; message?: unknown }
    return code === "user_request_timeout" && typeof message === "string" && message.startsWith("Timed out reading request body.")
  } catch {
    return false
  }
}

/** Check if response body contains rate_limited code */
function isRateLimitedInBody(responseText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(responseText)
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const err = (parsed as { error: unknown }).error
      if (err && typeof err === "object" && "code" in err) {
        return (err as { code: unknown }).code === "rate_limited"
      }
    }
  } catch {
    // Not JSON
  }
  return false
}

/** Try to extract token limit info from response body */
function tryExtractTokenLimit(responseText: string): { current: number; limit: number } | null {
  return extractTokenLimitFromResponseText(responseText)
}

/** Known network/socket error message patterns from Bun and Node.js fetch */
const NETWORK_ERROR_PATTERNS = [
  "socket",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "fetch failed",
  "network",
  "TLS",
  "CERT",
]

/**
 * Detect aborts (client cancel, shutdown, internal timeout watchdogs).
 *
 * AbortSignal-triggered errors surface in multiple shapes:
 *  - `DOMException` with `name === "AbortError"` (standard `AbortController`)
 *  - `Error` with `name === "AbortError"` or `"TimeoutError"` (`AbortSignal.timeout`)
 *  - Plain `Error` with message containing "abort" / "aborted" (project-internal
 *    aborts like `new Error("Upstream WebSocket request aborted")`)
 *
 * We check name first (cheap, exact) then fall back to message keywords so
 * project-internal aborts are also caught.
 */
export function isAbortError(error: Error): boolean {
  if (error.name === "AbortError" || error.name === "TimeoutError") return true
  const msg = error.message.toLowerCase()
  if (msg.includes("aborted") || msg.includes(" abort ") || msg.endsWith(" abort") || msg.startsWith("abort")) {
    return true
  }
  if (error.cause instanceof Error) return isAbortError(error.cause)
  return false
}

/** Check if an error is a network-level failure (socket, DNS, TLS, connection errors) */
function isNetworkError(error: Error): boolean {
  const msg = error.message.toLowerCase()
  if (NETWORK_ERROR_PATTERNS.some((pattern) => msg.includes(pattern.toLowerCase()))) return true

  if (error.cause instanceof Error) return isNetworkError(error.cause)

  return false
}

/**
 * HTTP/2 stream errors whose protocol semantics GUARANTEE the request was never
 * processed by the peer, making retry safe (RFC 9113 §5.1.2 & §8.7:
 * REFUSED_STREAM = "refused prior to performing any application processing";
 * "Any request that was sent on the reset stream can be safely retried … even
 * those with non-idempotent methods").
 *
 * Scoped deliberately to REFUSED_STREAM. It does NOT include NGHTTP2_CANCEL or
 * NGHTTP2_INTERNAL_ERROR — those carry no zero-processing guarantee, so blindly
 * retrying a POST could double-execute. Matching is on the message SUBSTRING, not
 * `error.code`: node:http2 (both Node and Bun) surfaces the generic code
 * "ERR_HTTP2_STREAM_ERROR" for REFUSED, CANCEL and INTERNAL_ERROR alike — only the
 * message distinguishes them (empirically confirmed, exp/http2-refused-retry/report.md).
 *
 * ERR_HTTP2_GOAWAY_SESSION is the same protocol-safe class per RFC (streams above the
 * GOAWAY Last-Stream-ID are unprocessed) but is not currently observed/reproduced —
 * add its token below if it appears in production logs.
 */
const HTTP2_RETRYABLE_MESSAGE_TOKENS = ["NGHTTP2_REFUSED_STREAM"]

function isRetryableHttp2StreamError(error: Error): boolean {
  const msg = error.message.toUpperCase()
  if (HTTP2_RETRYABLE_MESSAGE_TOKENS.some((token) => msg.includes(token))) return true

  if (error.cause instanceof Error) return isRetryableHttp2StreamError(error.cause)

  return false
}

/**
 * HTTP/2 pre-response teardown tokens — the connection died before ANY response
 * header arrived (status 0, zero frames). This is WEAKER than
 * {@link HTTP2_RETRYABLE_MESSAGE_TOKENS}: no protocol zero-processing guarantee,
 * only the strong evidence that the upstream returned not a single response byte.
 * Reconnect-and-resend is the only path to deliver a usable response (see the
 * classifyError branch). Kept in a SEPARATE list so the strict REFUSED_STREAM
 * semantics are never diluted.
 *
 * Substring uniqueness (verified): "closed before any response" is emitted ONLY
 * at http2-client.ts's `!headersReceived` close backstop. It does NOT overlap
 * with the mid-body "closed before end" (post-headers — must stay a body-stream
 * error, never re-classified as retryable here) nor with the buffered-retry
 * "closed without message_stop" truncation.
 */
const HTTP2_PRE_RESPONSE_RETRYABLE_TOKENS = ["upstream stream closed before any response"]

function isRetryablePreResponseHttp2Close(error: Error): boolean {
  const msg = error.message.toLowerCase()
  if (HTTP2_PRE_RESPONSE_RETRYABLE_TOKENS.some((token) => msg.includes(token))) return true

  if (error.cause instanceof Error) return isRetryablePreResponseHttp2Close(error.cause)

  return false
}
