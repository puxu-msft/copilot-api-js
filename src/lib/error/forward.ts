import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { HTTPError } from "./http-error"
import { extractTokenLimitFromResponseText, isUpstreamRateLimited } from "./parsing"
import { formatErrorWithCause, parseRetryAfterHeader } from "./utils"

/** Copilot error structure */
interface CopilotError {
  error?: {
    message?: string
    code?: string
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

/** Format Anthropic-compatible error for token limit exceeded */
function formatTokenLimitError(current: number, limit: number) {
  const excess = current - limit
  const percentage = Math.round((excess / limit) * 100)

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

export function forwardError(c: Context, error: unknown) {
  // Error file persistence is handled by the error-persistence consumer
  // (subscribes to "failed" events on RequestContext) — no inline writing here.
  if (error instanceof HTTPError) {
    const limitInfo = error.status === 400 ? extractTokenLimitFromResponseText(error.responseText) : null

    if (error.status === 413) {
      const formattedError = formatRequestTooLargeError()
      consola.warn("HTTP 413: Request too large")
      return c.json(formattedError, 413 as ContentfulStatusCode)
    }

    if (limitInfo?.current && limitInfo.limit) {
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

    if (error.status === 402) {
      const retryAfter = parseRetryAfterHeader(error.responseHeaders)
      const formattedError = formatQuotaExceededError(retryAfter)
      consola.warn(`HTTP 402: Quota exceeded${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`)
      return c.json(formattedError, 402 as ContentfulStatusCode)
    }

    if (error.status === 422) {
      const formattedError = formatContentFilteredError(error.responseText)
      consola.warn("HTTP 422: Content filtered by safety system")
      return c.json(formattedError, 422 as ContentfulStatusCode)
    }

    let errorJson: unknown
    try {
      errorJson = JSON.parse(error.responseText)
    } catch {
      errorJson = error.responseText
    }

    if (typeof errorJson === "object" && errorJson !== null) {
      const errorObj = errorJson as CopilotError & AnthropicError

      if (error.status === 429 || errorObj.error?.code === "rate_limited") {
        const formattedError = formatRateLimitError(errorObj.error?.message)
        consola.warn("HTTP 429: Rate limit exceeded")
        return c.json(formattedError, 429 as ContentfulStatusCode)
      }

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
      const formattedError = formatRateLimitError()
      consola.warn("HTTP 429: Rate limit exceeded")
      return c.json(formattedError, 429 as ContentfulStatusCode)
    }

    if (typeof errorJson === "string") {
      const isHtml = errorJson.trimStart().startsWith("<")
      const preview = isHtml ? `[HTML ${errorJson.length} bytes]` : truncateForLog(errorJson, 200)
      consola.error(`HTTP ${error.status}: ${preview}`)
    } else {
      consola.error(`HTTP ${error.status}:`, errorJson)
    }

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

/** Truncate a string for log display, adding ellipsis if truncated */
function truncateForLog(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}… (${text.length} bytes total)`
}
