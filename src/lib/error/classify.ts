import { HTTPError } from "./http-error"
import { extractRetryAfterFromBody, extractTokenLimitFromResponseText, isUpstreamRateLimited } from "./parsing"
import { formatErrorWithCause, parseRetryAfterHeader } from "./utils"

/** Structured error types for pipeline retry decisions */
export type ApiErrorType =
  | "rate_limited" // 429
  | "payload_too_large" // 413
  | "token_limit" // 200/400 but body contains token limit error
  | "content_filtered" // 422 — Responsible AI Service filtering
  | "quota_exceeded" // 402 — free tier / premium quota exceeded
  | "auth_expired" // Token expired
  | "network_error" // Connection failure
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
      raw: error,
    }
  }

  if (status >= 500) {
    return {
      type: "server_error",
      status,
      message,
      raw: error,
    }
  }

  if (status === 401 || status === 403) {
    return {
      type: "auth_expired",
      status,
      message,
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
        raw: error,
      }
    }
  }

  return {
    type: "bad_request",
    status,
    message,
    raw: error,
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
  "abort",
]

/** Check if an error is a network-level failure (socket, DNS, TLS, connection errors) */
function isNetworkError(error: Error): boolean {
  const msg = error.message.toLowerCase()
  if (NETWORK_ERROR_PATTERNS.some((pattern) => msg.includes(pattern.toLowerCase()))) return true

  if (error.cause instanceof Error) return isNetworkError(error.cause)

  return false
}
