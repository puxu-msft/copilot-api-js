import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { tryParseAndLearnLimit } from "./auto-truncate"
import { state } from "./state"

export class HTTPError extends Error {
  status: number
  responseText: string
  /** Model ID that caused the error (if known) */
  modelId?: string
  /** Original response headers (for Retry-After, quota snapshots, etc.) */
  responseHeaders?: Headers

  constructor(message: string, status: number, responseText: string, modelId?: string, responseHeaders?: Headers) {
    super(message)
    this.status = status
    this.responseText = responseText
    this.modelId = modelId
    this.responseHeaders = responseHeaders
  }

  static async fromResponse(message: string, response: Response, modelId?: string): Promise<HTTPError> {
    const text = await response.text()
    return new HTTPError(message, response.status, text, modelId, response.headers)
  }
}

/** Copilot error structure */
interface CopilotError {
  error?: {
    message?: string
    code?: string
  }
}

/** Parse token limit info from error message */
export function parseTokenLimitError(message: string): {
  current: number
  limit: number
} | null {
  // Match OpenAI format: "prompt token count of 135355 exceeds the limit of 128000"
  const openaiMatch = message.match(/prompt token count of (\d+) exceeds the limit of (\d+)/)
  if (openaiMatch) {
    return {
      current: Number.parseInt(openaiMatch[1], 10),
      limit: Number.parseInt(openaiMatch[2], 10),
    }
  }

  // Match Anthropic format: "prompt is too long: 208598 tokens > 200000 maximum"
  const anthropicMatch = message.match(/prompt is too long: (\d+) tokens > (\d+) maximum/)
  if (anthropicMatch) {
    return {
      current: Number.parseInt(anthropicMatch[1], 10),
      limit: Number.parseInt(anthropicMatch[2], 10),
    }
  }

  return null
}

/** Format Anthropic-compatible error for token limit exceeded */
function formatTokenLimitError(current: number, limit: number) {
  const excess = current - limit
  const percentage = Math.round((excess / limit) * 100)

  // Return Anthropic-compatible error that clients can recognize and handle
  // The "prompt_too_long" type is what Anthropic's API returns for context limit errors
  // This should trigger Claude Code's auto-truncate behavior
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        `prompt is too long: ${current} tokens > ${limit} maximum ` + `(${excess} tokens over, ${percentage}% excess)`,
    },
  }
}

/** Format Anthropic-compatible error for request too large (413) */
function formatRequestTooLargeError() {
  // Return Anthropic-compatible error for 413 Request Entity Too Large
  // This happens when the HTTP body is too large, separate from token limits
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "Request body too large. The HTTP request exceeds the server's size limit. "
        + "Try reducing the conversation history or removing large content like images.",
    },
  }
}

/** Format Anthropic-compatible error for rate limit exceeded (429) */
function formatRateLimitError(copilotMessage?: string) {
  // Return Anthropic-compatible error for 429 rate limit
  // The "rate_limit_error" type is what Anthropic's API returns for rate limiting
  return {
    type: "error",
    error: {
      type: "rate_limit_error",
      message: copilotMessage ?? "You have exceeded your rate limit. Please try again later.",
    },
  }
}

/** Format Anthropic-compatible error for quota exceeded (402) */
function formatQuotaExceededError(retryAfter?: number) {
  const retryInfo = retryAfter ? ` Quota resets in approximately ${retryAfter} seconds.` : ""
  return {
    type: "error",
    error: {
      type: "rate_limit_error",
      message: `You have exceeded your usage quota. Please try again later.${retryInfo}`,
    },
    ...(retryAfter !== undefined && { retry_after: retryAfter }),
  }
}

/** Format Anthropic-compatible error for content filtered (422) */
function formatContentFilteredError(responseText: string) {
  // Try to extract the original error message from the response
  let detail = ""
  try {
    const parsed = JSON.parse(responseText) as { error?: { message?: string } }
    if (parsed.error?.message) detail = `: ${parsed.error.message}`
  } catch {
    // Not JSON — use generic message
  }
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: `Content filtered by safety system${detail}`,
    },
  }
}

/** Anthropic error structure */
interface AnthropicError {
  type?: string
  error?: {
    type?: string
    message?: string
  }
}

export function forwardError(c: Context, error: unknown) {
  // Error file persistence is handled by the error-persistence consumer
  // (subscribes to "failed" events on RequestContext) — no inline writing here.

  if (error instanceof HTTPError) {
    // Try to detect and learn from token limit / body size errors
    // Only record limits for future pre-checks when auto-truncate is enabled
    const limitInfo = tryParseAndLearnLimit(error, error.modelId ?? "unknown", state.autoTruncate)

    // Handle 413 Request Entity Too Large
    if (error.status === 413) {
      const formattedError = formatRequestTooLargeError()
      consola.warn(`HTTP 413: Request too large`)
      return c.json(formattedError, 413 as ContentfulStatusCode)
    }

    // Handle token limit exceeded (detected by tryParseAndLearnLimit)
    if (limitInfo?.type === "token_limit" && limitInfo.current && limitInfo.limit) {
      const formattedError = formatTokenLimitError(limitInfo.current, limitInfo.limit)
      const excess = limitInfo.current - limitInfo.limit
      const percentage = Math.round((excess / limitInfo.limit) * 100)
      consola.warn(
        `HTTP ${error.status}: Token limit exceeded for ${error.modelId ?? "unknown"} `
          + `(${limitInfo.current.toLocaleString()} > ${limitInfo.limit.toLocaleString()}, `
          + `${excess.toLocaleString()} over, ${percentage}% excess)`,
      )
      return c.json(formattedError, 400 as ContentfulStatusCode)
    }

    // Handle 402 Quota Exceeded
    if (error.status === 402) {
      const retryAfter = parseRetryAfterHeader(error.responseHeaders)
      const formattedError = formatQuotaExceededError(retryAfter)
      consola.warn(`HTTP 402: Quota exceeded${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`)
      return c.json(formattedError, 402 as ContentfulStatusCode)
    }

    // Handle 422 Content Filtered (Responsible AI Service)
    if (error.status === 422) {
      const formattedError = formatContentFilteredError(error.responseText)
      consola.warn(`HTTP 422: Content filtered by safety system`)
      return c.json(formattedError, 422 as ContentfulStatusCode)
    }

    let errorJson: unknown
    try {
      errorJson = JSON.parse(error.responseText)
    } catch {
      errorJson = error.responseText
    }

    // Only attempt structured error detection on parsed JSON objects
    if (typeof errorJson === "object" && errorJson !== null) {
      const errorObj = errorJson as CopilotError & AnthropicError

      // Check for rate limit error from Copilot (429 with code "rate_limited")
      if (error.status === 429 || errorObj.error?.code === "rate_limited") {
        const formattedError = formatRateLimitError(errorObj.error?.message)
        consola.warn(`HTTP 429: Rate limit exceeded`)
        return c.json(formattedError, 429 as ContentfulStatusCode)
      }

      // Handle 503 upstream rate limit (distinguish from generic 503)
      if (error.status === 503 && isUpstreamRateLimited(error.responseText)) {
        const retryAfter = parseRetryAfterHeader(error.responseHeaders)
        const formattedError = formatRateLimitError(
          errorObj.error?.message ?? "Upstream provider rate limited. Please try again later.",
        )
        if (retryAfter) {
          ;(formattedError as Record<string, unknown>).retry_after = retryAfter
        }
        consola.warn(`HTTP 503: Upstream provider rate limited${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`)
        return c.json(formattedError, 503 as ContentfulStatusCode)
      }
    } else if (error.status === 429) {
      // Rate limit with non-JSON response
      const formattedError = formatRateLimitError()
      consola.warn(`HTTP 429: Rate limit exceeded`)
      return c.json(formattedError, 429 as ContentfulStatusCode)
    }

    // Log unhandled HTTP errors
    consola.error(`HTTP ${error.status}:`, errorJson)

    return c.json(
      {
        error: {
          message: error.responseText,
          type: "error",
        },
      },
      error.status as ContentfulStatusCode,
    )
  }

  // Non-HTTP errors (socket closures, DNS failures, timeouts, etc.)
  const errorMessage = error instanceof Error ? formatErrorWithCause(error) : String(error)
  consola.error(`Unexpected non-HTTP error in ${c.req.method} ${c.req.path}:`, errorMessage)

  return c.json(
    {
      error: {
        message: errorMessage,
        type: "error",
      },
    },
    500,
  )
}

// ─── Error Classification System ───

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

  // Generic Error
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

  // 422 Content Filtered (Responsible AI Service)
  if (status === 422) {
    return {
      type: "content_filtered",
      status,
      message,
      responseHeaders: error.responseHeaders,
      raw: error,
    }
  }

  // 402 Quota Exceeded (free tier / premium quota)
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

  // 429 Rate Limited
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

  // 413 Payload Too Large
  if (status === 413) {
    return {
      type: "payload_too_large",
      status,
      message,
      raw: error,
    }
  }

  // 503 — check if upstream provider rate limited
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

  // 5xx Server Errors (non-503, already handled above)
  if (status >= 500) {
    return {
      type: "server_error",
      status,
      message,
      raw: error,
    }
  }

  // 401/403 Auth Errors
  if (status === 401 || status === 403) {
    return {
      type: "auth_expired",
      status,
      message,
      raw: error,
    }
  }

  // 400 — check for token limit error in response body
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

    // Check for rate_limited code in body (some APIs return 400 for rate limits)
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

  // Default: bad_request
  return {
    type: "bad_request",
    status,
    message,
    raw: error,
  }
}

// ─── Retry-After Header Parsing ───

/**
 * Parse the `Retry-After` HTTP response header.
 * Supports both formats per RFC 7231:
 *   - Seconds: `Retry-After: 120` → 120
 *   - HTTP-date: `Retry-After: Fri, 31 Dec 2025 23:59:59 GMT` → seconds from now
 * Returns undefined if header is missing or unparseable.
 */
export function parseRetryAfterHeader(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined

  const value = headers.get("retry-after")
  if (!value) return undefined

  // Try as seconds (integer)
  const seconds = Number.parseInt(value, 10)
  if (!Number.isNaN(seconds) && String(seconds) === value.trim()) {
    return seconds > 0 ? seconds : undefined
  }

  // Try as HTTP-date
  const date = new Date(value)
  if (!Number.isNaN(date.getTime())) {
    const deltaMs = date.getTime() - Date.now()
    const deltaSec = Math.ceil(deltaMs / 1000)
    return deltaSec > 0 ? deltaSec : undefined
  }

  return undefined
}

// ─── Upstream Rate Limit Detection ───

/** Check if a 503 response body indicates upstream provider rate limiting */
function isUpstreamRateLimited(responseText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(responseText)
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const err = (parsed as { error: unknown }).error
      if (err && typeof err === "object") {
        // Check for rate limit indicators in error code or message
        const errObj = err as Record<string, unknown>
        if (typeof errObj.code === "string" && errObj.code.includes("rate")) return true
        if (typeof errObj.message === "string") {
          const msg = errObj.message.toLowerCase()
          if (msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("quota")) return true
        }
      }
    }
  } catch {
    // Not JSON — check raw text
    const lower = responseText.toLowerCase()
    if (lower.includes("rate limit") || lower.includes("too many requests")) return true
  }
  return false
}

/** Extract retry_after from JSON response body */
function extractRetryAfterFromBody(responseText: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(responseText)
    if (parsed && typeof parsed === "object") {
      // Top-level retry_after
      if ("retry_after" in parsed && typeof (parsed as Record<string, unknown>).retry_after === "number") {
        return (parsed as { retry_after: number }).retry_after
      }
      // Nested error.retry_after
      if ("error" in parsed) {
        const err = (parsed as { error: unknown }).error
        if (
          err
          && typeof err === "object"
          && "retry_after" in err
          && typeof (err as Record<string, unknown>).retry_after === "number"
        ) {
          return (err as { retry_after: number }).retry_after
        }
      }
    }
  } catch {
    // Not JSON
  }
  return undefined
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
  try {
    const parsed: unknown = JSON.parse(responseText)
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const err = (parsed as { error: unknown }).error
      if (
        err
        && typeof err === "object"
        && "message" in err
        && typeof (err as Record<string, unknown>).message === "string"
      ) {
        return parseTokenLimitError((err as { message: string }).message)
      }
    }
  } catch {
    // Not JSON
  }
  return null
}

// ─── Network Error Detection ───

/** Known network/socket error message patterns from Bun and Node.js fetch */
const NETWORK_ERROR_PATTERNS = [
  "socket", // "The socket connection was closed unexpectedly"
  "ECONNRESET", // Connection reset by peer
  "ECONNREFUSED", // Connection refused
  "ETIMEDOUT", // Connection timed out
  "ENETUNREACH", // Network unreachable
  "EHOSTUNREACH", // Host unreachable
  "EAI_AGAIN", // DNS lookup timeout
  "UND_ERR_SOCKET", // undici socket errors (Node.js)
  "fetch failed", // Generic fetch failure
  "network", // General network errors
  "TLS", // TLS/SSL errors
  "CERT", // Certificate errors
  "abort", // AbortError from timeouts
]

/** Check if an error is a network-level failure (socket, DNS, TLS, connection errors) */
function isNetworkError(error: Error): boolean {
  const msg = error.message.toLowerCase()
  if (NETWORK_ERROR_PATTERNS.some((p) => msg.includes(p.toLowerCase()))) return true

  // Check cause chain for network indicators
  if (error.cause instanceof Error) return isNetworkError(error.cause)

  return false
}

/**
 * Strip Bun's unhelpful verbose hint from error messages.
 * Bun appends "For more information, pass `verbose: true` in the second argument to fetch()"
 * to socket/network errors — this is an implementation detail, not useful to the user.
 */
function stripBunVerboseHint(message: string): string {
  return message.replace(/\s*For more information, pass `verbose: true`.*$/i, "")
}

/**
 * Format error message including cause chain, with Bun noise stripped.
 * Surfaces error.cause details (e.g. underlying socket/TLS reason) inline.
 */
export function formatErrorWithCause(error: Error): string {
  let msg = stripBunVerboseHint(error.message)
  if (error.cause instanceof Error && error.cause.message && error.cause.message !== error.message) {
    msg += ` (cause: ${stripBunVerboseHint(error.cause.message)})`
  }
  return msg
}

// ─── Error Message Extraction ───

/** Extract error message with fallback. For HTTPError, extracts the actual API error response. */
export function getErrorMessage(error: unknown, fallback = "Unknown error"): string {
  if (error instanceof Error) {
    if ("responseText" in error && typeof (error as { responseText: unknown }).responseText === "string") {
      const responseText = (error as { responseText: string }).responseText
      const status = "status" in error ? (error as { status: number }).status : undefined
      try {
        const parsed = JSON.parse(responseText) as { error?: { message?: string; type?: string } }
        if (parsed.error?.message) {
          return status ? `HTTP ${status}: ${parsed.error.message}` : parsed.error.message
        }
      } catch {
        if (responseText.length > 0 && responseText.length < 500) {
          return status ? `HTTP ${status}: ${responseText}` : responseText
        }
      }
      return status ? `HTTP ${status}: ${error.message}` : error.message
    }
    // For non-HTTP errors, include cause information (e.g. Bun verbose fetch details)
    return formatErrorWithCause(error)
  }
  return fallback
}
