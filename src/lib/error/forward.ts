import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import type { RequestContext } from "~/lib/context/request"

import { isAbortError } from "~/lib/error/classify"
import { HTTPError } from "~/lib/error/http-error"
import {
  //
  extractTokenLimitFromResponseText,
  isUpstreamRateLimited,
} from "~/lib/error/parsing"
import {
  //
  formatErrorWithCause,
  looksLikeHtml,
  parseRetryAfterHeader,
} from "~/lib/error/utils"
import { state } from "~/lib/state"
import { logToolDiagnostics } from "~/lib/upstream-diagnostics"

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
      message: `prompt is too long: ${current} tokens > ${limit} maximum ` + `(${excess} tokens over, ${percentage}% excess)`,
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
  return geminiEnvelope(413, "Request payload size exceeds the limit. Try reducing the conversation history or removing large content.", "INVALID_ARGUMENT")
}

function formatRateLimitErrorGemini(message?: string) {
  return geminiEnvelope(429, message ?? "Resource has been exhausted (e.g. check quota).", "RESOURCE_EXHAUSTED")
}

function formatQuotaExceededErrorGemini(retryAfter?: number) {
  const retryInfo = retryAfter ? ` Quota resets in approximately ${retryAfter} seconds.` : ""
  return {
    ...geminiEnvelope(402, `You have exceeded your usage quota. Please try again later.${retryInfo}`, "RESOURCE_EXHAUSTED"),
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

/** Log descriptor returned by {@link mapHttpErrorToEnvelope} — emitted by the caller, NOT here, so the status dispatch stays pure + single-sourced. */
interface ErrorEnvelopeLog {
  level: "warn" | "error"
  message: string
  /** Optional second consola arg (the default path logs the parsed errorJson object). */
  data?: unknown
}

/**
 * Map an upstream {@link HTTPError} to its wire envelope for `format` — the PURE
 * status→{body,status} dispatch shared by {@link forwardError} (→ `c.json`) and the
 * streaming POST-COMMIT error-frame synthesis (RFC ③, docs/spec/pre-response-abort-handling.md §4.2.5).
 * NO side effects: the `log` descriptor is emitted by the caller (keeps the branching
 * single-sourced), and `classified` (false only on the default fall-through) tells the
 * caller where tool-diagnostics augmentation applies. The Anthropic helper outputs are
 * already shaped like an SSE `error` event's data, so ③ uses `body` verbatim.
 */
export function mapHttpErrorToEnvelope(
  error: HTTPError,
  format: ErrorWireFormat,
): { body: Record<string, unknown>; status: number; log: ErrorEnvelopeLog; classified: boolean } {
  const helpers = pickHelpers(format)
  const limitInfo = error.status === 400 ? extractTokenLimitFromResponseText(error.responseText) : null

  if (error.status === 413) {
    return { body: helpers.requestTooLarge(), status: 413, log: { level: "warn", message: "HTTP 413: Request too large" }, classified: true }
  }

  if (limitInfo?.current && limitInfo.limit) {
    const excess = limitInfo.current - limitInfo.limit
    const percentage = Math.round((excess / limitInfo.limit) * 100)
    return {
      body: helpers.tokenLimit(limitInfo.current, limitInfo.limit),
      status: 400,
      log: {
        level: "warn",
        message:
          `HTTP ${error.status}: Token limit exceeded for ${error.modelId ?? "unknown"} `
          + `(${limitInfo.current.toLocaleString()} > ${limitInfo.limit.toLocaleString()}, `
          + `${excess.toLocaleString()} over, ${percentage}% excess)`,
      },
      classified: true,
    }
  }

  if (error.status === 402) {
    const retryAfter = parseRetryAfterHeader(error.responseHeaders)
    return {
      body: helpers.quotaExceeded(retryAfter),
      status: 402,
      log: { level: "warn", message: `HTTP 402: Quota exceeded${retryAfter ? ` (retry after ${retryAfter}s)` : ""}` },
      classified: true,
    }
  }

  if (error.status === 422) {
    return {
      body: helpers.contentFiltered(error.responseText),
      status: 422,
      log: { level: "warn", message: "HTTP 422: Content filtered by safety system" },
      classified: true,
    }
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
      return {
        body: helpers.rateLimit(errorObj.error?.message),
        status: 429,
        log: { level: "warn", message: "HTTP 429: Rate limit exceeded" },
        classified: true,
      }
    }

    if (error.status === 503 && isUpstreamRateLimited(error.responseText)) {
      const retryAfter = parseRetryAfterHeader(error.responseHeaders)
      const body = helpers.rateLimit(errorObj.error?.message ?? "Upstream provider rate limited. Please try again later.")
      if (retryAfter) {
        body.retry_after = retryAfter
      }
      return {
        body,
        status: 503,
        log: { level: "warn", message: `HTTP 503: Upstream provider rate limited${retryAfter ? ` (retry after ${retryAfter}s)` : ""}` },
        classified: true,
      }
    }
  } else if (error.status === 429) {
    return { body: helpers.rateLimit(), status: 429, log: { level: "warn", message: "HTTP 429: Rate limit exceeded" }, classified: true }
  }

  // Default pass-through (unclassified) — the caller attaches tool diagnostics here.
  // The body gets one of three treatments. This is a DELIBERATE decision matrix
  // (documented in DESIGN.md error/), not incidental behavior:
  //   1. HTML page  → REPLACED. A gateway/CDN edge page (e.g. GitHub's "502 Unicorn!")
  //      is never a usable API error body; forwarding kilobytes of markup as
  //      `error.message` only pollutes the client. Detected two ways: a structural body
  //      sniff (leading `<`) OR an explicit `content-type: text/html` header (catches HTML
  //      that doesn't lead with `<`). xhtml/xml content-types are intentionally NOT matched
  //      on the header (would swallow legit `application/xml` errors); an xml page leading
  //      with `<` is still caught by the sniff.
  //   2. empty body → FILLED with a synthetic status-only message. A bare 5xx from a
  //      gateway with no body would otherwise hand the client an empty `error.message`.
  //   3. anything else, INCLUDING structured JSON → forwarded VERBATIM, ON PURPOSE. When
  //      upstream returns a JSON error body it deliberately chose to expose structured
  //      content downstream, so the proxy does NOT extract `.error.message` or reshape it —
  //      the client sees exactly what upstream sent. History also retains the raw body
  //      (richest-data-flow). The `typeof errorJson === "string"` guard keeps a (rare)
  //      html-typed-but-valid-JSON body on this JSON path.
  const contentTypeIsHtml = error.responseHeaders?.get("content-type")?.toLowerCase().includes("text/html") ?? false
  const bodyIsHtml = typeof errorJson === "string" && (looksLikeHtml(errorJson) || contentTypeIsHtml)
  const bodyIsEmpty = error.responseText.trim() === ""

  // Log descriptor for a string body — priority empty > html > raw.
  const describeStringBody = (s: string): string => {
    if (bodyIsEmpty) return "[empty body]"
    if (bodyIsHtml) return `[HTML ${s.length} bytes]`
    return truncateForLog(s, 200)
  }
  const log: ErrorEnvelopeLog =
    typeof errorJson === "string" ?
      { level: "error", message: `HTTP ${error.status}: ${describeStringBody(errorJson)}` }
    : { level: "error", message: `HTTP ${error.status}:`, data: errorJson }

  // Client message — same priority empty > html > raw so it agrees with the log
  // (an empty html-typed body is "empty", not "an HTML page of 0 bytes"). Raw verbatim
  // is the default (case 3): structured JSON is forwarded untouched, ON PURPOSE.
  let bodyMessage = error.responseText
  if (bodyIsEmpty) {
    bodyMessage = `Upstream returned HTTP ${error.status} with an empty response body.`
  } else if (bodyIsHtml) {
    bodyMessage =
      `Upstream gateway returned an HTML error page (HTTP ${error.status}, ${error.responseText.length} bytes) instead of a JSON API error. `
      + `The Copilot API gateway is likely unavailable or failing at the edge; retry shortly.`
  }
  return { body: helpers.defaultError(bodyMessage, error.status >= 500, error.status), status: error.status, log, classified: false }
}

function finalizeErrorDelivery(c: Context, body: Record<string, unknown>, status: ContentfulStatusCode): Response {
  const response = c.json(body, status)
  const getContext = (c as unknown as { get?: (key: string) => unknown }).get
  const candidate = (typeof getContext === "function" ? getContext.call(c, "requestContext") : undefined) as Partial<RequestContext> | undefined
  if (
    candidate
    && typeof candidate.setForwardedResponse === "function"
    && typeof candidate.setInboundResponseHeaders === "function"
    && typeof candidate.setClientResponseStatus === "function"
    && typeof candidate.finalizeModelOperationDelivery === "function"
  ) {
    const ctx = candidate as RequestContext
    ctx.setForwardedResponse({ content: body })
    ctx.setInboundResponseHeaders(Object.fromEntries(response.headers.entries()))
    ctx.setClientResponseStatus(response.status)
    ctx.finalizeModelOperationDelivery({ clientPayload: body })
  }
  return response
}

export function forwardError(c: Context, error: unknown, format: ErrorWireFormat = "anthropic") {
  const helpers = pickHelpers(format)

  if (error instanceof HTTPError) {
    const { body, status, log, classified } = mapHttpErrorToEnvelope(error, format)
    if (log.data !== undefined) consola[log.level](log.message, log.data)
    else consola[log.level](log.message)

    // Hint-only tool-schema diagnostics attached by the client on suspicious 400s —
    // ONLY on the unclassified default path (token-limit / 413 / 422 / 429 / 503 envelopes
    // intentionally omit them: their root cause is already known). Warn + surface as a
    // sibling field so the standard error envelope (`error: {...}`) is left untouched;
    // the diagnostics are still persisted to History via RequestContext.fail().
    if (!classified && error.diagnostics) {
      logToolDiagnostics(error.modelId ?? "unknown", error.diagnostics)
      body.tool_diagnostics = error.diagnostics
    }
    return finalizeErrorDelivery(c, body, status as ContentfulStatusCode)
  }

  const errorMessage = error instanceof Error ? formatErrorWithCause(error) : String(error)

  // Aborts (client cancel or upstream response-header timeout) are EXPECTED
  // operational conditions, not "unexpected" server bugs — classify them out of
  // the generic 500 catch-all below. Discriminate by the inbound request signal:
  // a client disconnect aborts `c.req.raw.signal`; a response-header timeout fires
  // on the fetch signal only, leaving `raw.signal` un-aborted. `error.name` can't
  // be used — the http2 client synthesizes a generic AbortError (dropping the
  // AbortSignal.timeout TimeoutError identity); see classify.ts / http2-client.ts.
  if (error instanceof Error && isAbortError(error)) {
    // `c.req.raw.signal` is the inbound request signal; cast to optional for
    // defensive test contexts (mirrors abort-bridge.ts).
    const clientSignal = c.req.raw.signal as AbortSignal | undefined
    if (clientSignal?.aborted) {
      consola.debug(`Client disconnected (pre-response) in ${c.req.method} ${c.req.path}`)
      return finalizeErrorDelivery(c, helpers.defaultError("Client closed request", false, 499), 499 as ContentfulStatusCode)
    }
    consola.warn(`Upstream response-header timeout in ${c.req.method} ${c.req.path} (${state.responseHeaderTimeout}s)`)
    return finalizeErrorDelivery(c, helpers.defaultError("Upstream timed out before sending response headers", true, 504), 504 as ContentfulStatusCode)
  }

  consola.error(`Unexpected non-HTTP error in ${c.req.method} ${c.req.path}:`, errorMessage)

  return finalizeErrorDelivery(c, helpers.defaultError(errorMessage, true, 500), 500)
}

/** Truncate a string for log display, adding ellipsis if truncated */
function truncateForLog(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}… (${text.length} bytes total)`
}
