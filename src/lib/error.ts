import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  status: number
  responseText: string

  constructor(message: string, status: number, responseText: string) {
    super(message)
    this.status = status
    this.responseText = responseText
  }

  static async fromResponse(
    message: string,
    response: Response,
  ): Promise<HTTPError> {
    const text = await response.text()
    return new HTTPError(message, response.status, text)
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
function parseTokenLimitError(message: string): {
  current: number
  limit: number
} | null {
  // Match: "prompt token count of 135355 exceeds the limit of 128000"
  const match = message.match(
    /prompt token count of (\d+) exceeds the limit of (\d+)/,
  )
  if (match) {
    return {
      current: Number.parseInt(match[1], 10),
      limit: Number.parseInt(match[2], 10),
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
  // This should trigger Claude Code's auto-compact behavior
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        `prompt is too long: ${current} tokens > ${limit} maximum `
        + `(${excess} tokens over, ${percentage}% excess)`,
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
      message:
        copilotMessage
        ?? "You have exceeded your rate limit. Please try again later.",
    },
  }
}

export function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    // Handle 413 Request Entity Too Large
    if (error.status === 413) {
      const formattedError = formatRequestTooLargeError()
      consola.debug("Returning formatted 413 error:", formattedError)
      return c.json(formattedError, 413 as ContentfulStatusCode)
    }

    let errorJson: unknown
    try {
      errorJson = JSON.parse(error.responseText)
    } catch {
      errorJson = error.responseText
    }
    consola.error("HTTP error:", errorJson)

    // Check for token limit exceeded error from Copilot
    const copilotError = errorJson as CopilotError
    if (copilotError.error?.code === "model_max_prompt_tokens_exceeded") {
      const tokenInfo = parseTokenLimitError(copilotError.error.message ?? "")
      if (tokenInfo) {
        const formattedError = formatTokenLimitError(
          tokenInfo.current,
          tokenInfo.limit,
        )
        consola.debug("Returning formatted token limit error:", formattedError)
        return c.json(formattedError, 400 as ContentfulStatusCode)
      }
    }

    // Check for rate limit error from Copilot (429 with code "rate_limited")
    if (error.status === 429 || copilotError.error?.code === "rate_limited") {
      const formattedError = formatRateLimitError(copilotError.error?.message)
      consola.debug("Returning formatted rate limit error:", formattedError)
      return c.json(formattedError, 429 as ContentfulStatusCode)
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
