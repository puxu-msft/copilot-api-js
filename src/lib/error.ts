import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { onTokenLimitExceeded } from "./auto-truncate-common"

export class HTTPError extends Error {
  status: number
  responseText: string
  /** Model ID that caused the error (if known) */
  modelId?: string

  constructor(
    message: string,
    status: number,
    responseText: string,
    modelId?: string,
  ) {
    super(message)
    this.status = status
    this.responseText = responseText
    this.modelId = modelId
  }

  static async fromResponse(
    message: string,
    response: Response,
    modelId?: string,
  ): Promise<HTTPError> {
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
function parseTokenLimitError(message: string): {
  current: number
  limit: number
} | null {
  // Match OpenAI format: "prompt token count of 135355 exceeds the limit of 128000"
  const openaiMatch = message.match(
    /prompt token count of (\d+) exceeds the limit of (\d+)/,
  )
  if (openaiMatch) {
    return {
      current: Number.parseInt(openaiMatch[1], 10),
      limit: Number.parseInt(openaiMatch[2], 10),
    }
  }

  // Match Anthropic format: "prompt is too long: 208598 tokens > 200000 maximum"
  const anthropicMatch = message.match(
    /prompt is too long: (\d+) tokens > (\d+) maximum/,
  )
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
    // Handle 413 Request Entity Too Large
    if (error.status === 413) {
      const formattedError = formatRequestTooLargeError()
      consola.warn(`HTTP 413: Request too large`)
      return c.json(formattedError, 413 as ContentfulStatusCode)
    }

    let errorJson: unknown
    try {
      errorJson = JSON.parse(error.responseText)
    } catch {
      errorJson = error.responseText
    }

    // Check for token limit exceeded error from Copilot (OpenAI format)
    const copilotError = errorJson as CopilotError
    if (copilotError.error?.code === "model_max_prompt_tokens_exceeded") {
      const tokenInfo = parseTokenLimitError(copilotError.error.message ?? "")
      if (tokenInfo) {
        // Adjust dynamic token limit for future requests
        if (error.modelId) {
          onTokenLimitExceeded(error.modelId, tokenInfo.limit)
        }
        const formattedError = formatTokenLimitError(
          tokenInfo.current,
          tokenInfo.limit,
        )
        consola.warn(
          `HTTP ${error.status}: Token limit exceeded (${tokenInfo.current} > ${tokenInfo.limit})`,
        )
        return c.json(formattedError, 400 as ContentfulStatusCode)
      }
    }

    // Check for token limit exceeded error from Anthropic format
    const anthropicError = errorJson as AnthropicError
    if (anthropicError.error?.type === "invalid_request_error") {
      const tokenInfo = parseTokenLimitError(anthropicError.error.message ?? "")
      if (tokenInfo) {
        // Adjust dynamic token limit for future requests
        if (error.modelId) {
          onTokenLimitExceeded(error.modelId, tokenInfo.limit)
        }
        const formattedError = formatTokenLimitError(
          tokenInfo.current,
          tokenInfo.limit,
        )
        consola.warn(
          `HTTP ${error.status}: Token limit exceeded (${tokenInfo.current} > ${tokenInfo.limit})`,
        )
        return c.json(formattedError, 400 as ContentfulStatusCode)
      }
    }

    // Check for rate limit error from Copilot (429 with code "rate_limited")
    if (error.status === 429 || copilotError.error?.code === "rate_limited") {
      const formattedError = formatRateLimitError(copilotError.error?.message)
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
  consola.error("Unexpected error:", error)

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
