import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { HTTPError } from "./http-error"
import {
  //
  extractTokenLimitFromResponseText,
  isUpstreamRateLimited,
} from "./parsing"
import {
  //
  formatErrorWithCause,
  parseRetryAfterHeader,
} from "./utils"

/**
 * Wire format for the error response body.
 *
 * - `anthropic` → `{ type: "error", error: { type: "<taxonomy>", message } }`
 *   used by `/v1/messages` clients and matches the Anthropic Messages API
 *   `error_response` shape.
 * - `openai` → `{ error: { message, type, code, param? } }`
 *   used by OpenAI / Azure-OpenAI / Embeddings / Responses clients. OpenAI
 *   SDKs key retry/branch decisions on `error.type` and `error.code` (e.g.
 *   `rate_limit_exceeded`, `insufficient_quota`, `context_length_exceeded`)
 *   so the proxy must emit those literals — Anthropic's `rate_limit_error`
 *   is not recognized by OpenAI SDK retry logic.
 * - `gemini` → `{ error: { code: <http-status>, message, status: <GRPC_STATUS> } }`
 *   used by `/v1beta/models/*` clients (Gemini CLI, `@google/genai`). The
 *   `status` field is a gRPC canonical code string (INVALID_ARGUMENT,
 *   NOT_FOUND, RESOURCE_EXHAUSTED, INTERNAL, UNAVAILABLE, ...). Mapping
 *   follows https://ai.google.dev/api/rest patterns.
 */
export type ErrorWireFormat = "anthropic" | "openai" | "gemini"

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

// ============================================================================
// Anthropic-shape error envelopes
// ============================================================================

/** Format Anthropic-compatible error for token limit exceeded */
function formatTokenLimitErrorAnthropic(current: number, limit: number) {
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
function formatRequestTooLargeErrorAnthropic() {
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
function formatRateLimitErrorAnthropic(copilotMessage?: string) {
  return {
    type: "error",
    error: {
      type: "rate_limit_error",
      message: copilotMessage ?? "You have exceeded your rate limit. Please try again later.",
    },
  }
}

/** Format Anthropic-compatible error for quota exceeded (402) */
function formatQuotaExceededErrorAnthropic(retryAfter?: number) {
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
function formatContentFilteredErrorAnthropic(responseText: string) {
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

// ============================================================================
// OpenAI-shape error envelopes
// ============================================================================
// OpenAI taxonomy reference: https://platform.openai.com/docs/guides/error-codes
// SDKs (openai-python, openai-node, LangChain, LiteLLM) branch on `error.type`
// and `error.code` — we must emit the canonical literals or those clients
// silently degrade their retry / fallback logic.

/** OpenAI: token-limit (400 → context_length_exceeded) */
function formatTokenLimitErrorOpenAI(current: number, limit: number) {
  const excess = current - limit
  const percentage = Math.round((excess / limit) * 100)
  return {
    error: {
      message:
        `This model's maximum context length is ${limit} tokens. `
        + `However, your messages resulted in ${current} tokens `
        + `(${excess} over, ${percentage}% excess). `
        + `Please reduce the length of the messages.`,
      type: "invalid_request_error",
      param: "messages",
      code: "context_length_exceeded",
    },
  }
}

/** OpenAI: 413 request_too_large */
function formatRequestTooLargeErrorOpenAI() {
  return {
    error: {
      message:
        "Request body too large. The HTTP request exceeds the server's size limit. "
        + "Try reducing the conversation history or removing large content like images.",
      type: "invalid_request_error",
      param: null,
      code: "request_too_large",
    },
  }
}

/** OpenAI: 429 rate_limit_exceeded */
function formatRateLimitErrorOpenAI(copilotMessage?: string) {
  return {
    error: {
      message: copilotMessage ?? "Rate limit reached. Please try again later.",
      type: "rate_limit_exceeded",
      param: null,
      code: "rate_limit_exceeded",
    },
  }
}

/** OpenAI: 402 insufficient_quota */
function formatQuotaExceededErrorOpenAI(retryAfter?: number) {
  const retryInfo = retryAfter ? ` Quota resets in approximately ${retryAfter} seconds.` : ""
  return {
    error: {
      message: `You exceeded your current quota, please check your plan and billing details.${retryInfo}`,
      type: "insufficient_quota",
      param: null,
      code: "insufficient_quota",
    },
    ...(retryAfter !== undefined && { retry_after: retryAfter }),
  }
}

/** OpenAI: 422 content_filter */
function formatContentFilteredErrorOpenAI(responseText: string) {
  let detail = ""
  try {
    const parsed = JSON.parse(responseText) as { error?: { message?: string } }
    if (parsed.error?.message) detail = `: ${parsed.error.message}`
  } catch {
    // Not JSON — use generic message
  }
  return {
    error: {
      message: `Content filtered by safety system${detail}`,
      type: "invalid_request_error",
      param: null,
      code: "content_filter",
    },
  }
}

// ============================================================================
// Gemini-shape error envelopes
// ============================================================================
// Gemini error reference: https://ai.google.dev/api/rest (errors section).
// Body shape: `{ error: { code, message, status, details? } }` where `status`
// is the gRPC canonical-code string. SDK clients (`@google/genai`, Gemini CLI)
// surface this `status` literal when they raise GoogleGenerativeAIError.

/** Map an HTTP status to a gRPC canonical-code string for the `status` field */
function geminiStatusFromHttp(status: number): string {
  if (status === 400) return "INVALID_ARGUMENT"
  if (status === 401) return "UNAUTHENTICATED"
  if (status === 403) return "PERMISSION_DENIED"
  if (status === 404) return "NOT_FOUND"
  if (status === 408) return "DEADLINE_EXCEEDED"
  if (status === 409) return "ABORTED"
  if (status === 412) return "FAILED_PRECONDITION"
  if (status === 413) return "INVALID_ARGUMENT"
  if (status === 422) return "INVALID_ARGUMENT"
  if (status === 429) return "RESOURCE_EXHAUSTED"
  if (status === 499) return "CANCELLED"
  if (status === 501) return "UNIMPLEMENTED"
  if (status === 502) return "UNAVAILABLE"
  if (status === 503) return "UNAVAILABLE"
  if (status === 504) return "DEADLINE_EXCEEDED"
  if (status >= 500) return "INTERNAL"
  return "UNKNOWN"
}

function geminiEnvelope(code: number, message: string, status?: string) {
  return {
    error: {
      code,
      message,
      status: status ?? geminiStatusFromHttp(code),
    },
  }
}

function formatTokenLimitErrorGemini(current: number, limit: number) {
  const excess = current - limit
  const percentage = Math.round((excess / limit) * 100)
  return geminiEnvelope(
    400,
    `The input token count (${current}) exceeds the maximum number of tokens allowed (${limit}). `
      + `Reduce the input by ${excess} tokens (${percentage}% excess).`,
    "INVALID_ARGUMENT",
  )
}

function formatRequestTooLargeErrorGemini() {
  return geminiEnvelope(
    413,
    "Request payload size exceeds the limit. Try reducing the conversation history or removing large content.",
    "INVALID_ARGUMENT",
  )
}

function formatRateLimitErrorGemini(message?: string) {
  return geminiEnvelope(429, message ?? "Resource has been exhausted (e.g. check quota).", "RESOURCE_EXHAUSTED")
}

function formatQuotaExceededErrorGemini(retryAfter?: number) {
  const retryInfo = retryAfter ? ` Quota resets in approximately ${retryAfter} seconds.` : ""
  return {
    ...geminiEnvelope(
      402,
      `You have exceeded your usage quota. Please try again later.${retryInfo}`,
      "RESOURCE_EXHAUSTED",
    ),
    ...(retryAfter !== undefined && { retry_after: retryAfter }),
  }
}

function formatContentFilteredErrorGemini(responseText: string) {
  let detail = ""
  try {
    const parsed = JSON.parse(responseText) as { error?: { message?: string } }
    if (parsed.error?.message) detail = `: ${parsed.error.message}`
  } catch {
    // Not JSON — use generic message
  }
  return geminiEnvelope(422, `Content filtered by safety system${detail}`, "INVALID_ARGUMENT")
}

// ============================================================================
// Format dispatcher
// ============================================================================

interface FormatHelpers {
  tokenLimit(current: number, limit: number): Record<string, unknown>
  requestTooLarge(): Record<string, unknown>
  rateLimit(message?: string): Record<string, unknown>
  quotaExceeded(retryAfter?: number): Record<string, unknown>
  contentFiltered(responseText: string): Record<string, unknown>
  defaultError(message: string, isServerError: boolean, status: number): Record<string, unknown>
}

const ANTHROPIC_HELPERS: FormatHelpers = {
  tokenLimit: formatTokenLimitErrorAnthropic,
  requestTooLarge: formatRequestTooLargeErrorAnthropic,
  rateLimit: formatRateLimitErrorAnthropic,
  quotaExceeded: formatQuotaExceededErrorAnthropic,
  contentFiltered: formatContentFilteredErrorAnthropic,
  defaultError: (message) => ({
    error: { message, type: "error" },
  }),
}

const OPENAI_HELPERS: FormatHelpers = {
  tokenLimit: formatTokenLimitErrorOpenAI,
  requestTooLarge: formatRequestTooLargeErrorOpenAI,
  rateLimit: formatRateLimitErrorOpenAI,
  quotaExceeded: formatQuotaExceededErrorOpenAI,
  contentFiltered: formatContentFilteredErrorOpenAI,
  defaultError: (message, isServerError, status) => ({
    error: {
      message,
      type: isServerError ? "server_error" : "api_error",
      param: null,
      code: status === 401 || status === 403 ? "invalid_api_key" : null,
    },
  }),
}

const GEMINI_HELPERS: FormatHelpers = {
  tokenLimit: formatTokenLimitErrorGemini,
  requestTooLarge: formatRequestTooLargeErrorGemini,
  rateLimit: formatRateLimitErrorGemini,
  quotaExceeded: formatQuotaExceededErrorGemini,
  contentFiltered: formatContentFilteredErrorGemini,
  defaultError: (message, _isServerError, status) => geminiEnvelope(status, message),
}

function pickHelpers(format: ErrorWireFormat): FormatHelpers {
  if (format === "openai") return OPENAI_HELPERS
  if (format === "gemini") return GEMINI_HELPERS
  return ANTHROPIC_HELPERS
}

export function forwardError(c: Context, error: unknown, format: ErrorWireFormat = "anthropic") {
  const helpers = pickHelpers(format)

  if (error instanceof HTTPError) {
    const limitInfo = error.status === 400 ? extractTokenLimitFromResponseText(error.responseText) : null

    if (error.status === 413) {
      const formattedError = helpers.requestTooLarge()
      consola.warn("HTTP 413: Request too large")
      return c.json(formattedError, 413 as ContentfulStatusCode)
    }

    if (limitInfo?.current && limitInfo.limit) {
      const formattedError = helpers.tokenLimit(limitInfo.current, limitInfo.limit)
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
      const formattedError = helpers.quotaExceeded(retryAfter)
      consola.warn(`HTTP 402: Quota exceeded${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`)
      return c.json(formattedError, 402 as ContentfulStatusCode)
    }

    if (error.status === 422) {
      const formattedError = helpers.contentFiltered(error.responseText)
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
        const formattedError = helpers.rateLimit(errorObj.error?.message)
        consola.warn("HTTP 429: Rate limit exceeded")
        return c.json(formattedError, 429 as ContentfulStatusCode)
      }

      if (error.status === 503 && isUpstreamRateLimited(error.responseText)) {
        const retryAfter = parseRetryAfterHeader(error.responseHeaders)
        const formattedError = helpers.rateLimit(
          errorObj.error?.message ?? "Upstream provider rate limited. Please try again later.",
        )
        if (retryAfter) {
          formattedError.retry_after = retryAfter
        }
        consola.warn(`HTTP 503: Upstream provider rate limited${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`)
        return c.json(formattedError, 503 as ContentfulStatusCode)
      }
    } else if (error.status === 429) {
      const formattedError = helpers.rateLimit()
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
      helpers.defaultError(error.responseText, error.status >= 500, error.status),
      error.status as ContentfulStatusCode,
    )
  }

  const errorMessage = error instanceof Error ? formatErrorWithCause(error) : String(error)
  consola.error(`Unexpected non-HTTP error in ${c.req.method} ${c.req.path}:`, errorMessage)

  return c.json(helpers.defaultError(errorMessage, true, 500), 500)
}

/** Truncate a string for log display, adding ellipsis if truncated */
function truncateForLog(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}… (${text.length} bytes total)`
}
