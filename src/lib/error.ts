import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { tryParseAndLearnLimit } from "./auto-truncate-common"

export class HTTPError extends Error {
  status: number
  responseText: string
  /** Model ID that caused the error (if known) */
  modelId?: string

  constructor(message: string, status: number, responseText: string, modelId?: string) {
    super(message)
    this.status = status
    this.responseText = responseText
    this.modelId = modelId
  }

  static async fromResponse(message: string, response: Response, modelId?: string): Promise<HTTPError> {
    const text = await response.text()
    return new HTTPError(message, response.status, text, modelId)
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

/** Anthropic error structure */
interface AnthropicError {
  type?: string
  error?: {
    type?: string
    message?: string
  }
}

export function forwardError(c: Context, error: unknown) {
  if (error instanceof HTTPError) {
    // Try to detect and learn from token limit / body size errors
    // This also records the limit for future auto-truncate pre-checks
    const limitInfo = tryParseAndLearnLimit(error, error.modelId ?? "unknown")

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

  // Non-HTTP errors
  consola.error(`Unexpected non-HTTP error in ${c.req.method} ${c.req.path}:`, error)

  return c.json(
    {
      error: {
        message: (error as Error).message,
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
  | "content_filtered" // Content filtering
  | "auth_expired" // Token expired
  | "network_error" // Connection failure
  | "server_error" // 5xx
  | "bad_request" // 400 (non-token-limit)

/** Classified API error with structured metadata */
export interface ApiError {
  type: ApiErrorType
  status: number
  message: string
  /** Retry-After seconds (rate_limited) */
  retryAfter?: number
  /** Token limit from error response (token_limit) */
  tokenLimit?: number
  /** Current token count from error response (token_limit) */
  tokenCurrent?: number
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

  // Network errors (fetch failures, timeouts, etc.)
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return {
      type: "network_error",
      status: 0,
      message: error.message,
      raw: error,
    }
  }

  // Generic Error
  if (error instanceof Error) {
    return {
      type: "bad_request",
      status: 0,
      message: error.message,
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

  // 429 Rate Limited
  if (status === 429) {
    const retryAfter = extractRetryAfterFromBody(responseText)
    return {
      type: "rate_limited",
      status,
      message,
      retryAfter,
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

  // 5xx Server Errors
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
      const retryAfter = extractRetryAfterFromBody(responseText)
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
    return error.message
  }
  return fallback
}
