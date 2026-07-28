/**
 * Map streaming lifecycle errors to OpenAI-shaped SSE `error.type` strings.
 *
 * Shared by the Chat Completions and Responses streaming handlers so all three
 * surfaces (chat-completions, responses, responses fallback) classify a
 * shutdown / idle-timeout / other failure identically.
 */

import type {
  //
  SseFrame,
  StreamErrorKind,
} from "~/lib/stream"

import { classifyStreamError } from "~/lib/stream"

/**
 * OpenAI SSE `error.type` for an already-classified stream-lifecycle error kind.
 *   idle-timeout → "timeout_error"
 *   shutdown     → "server_error" (5xx-class transient — client backs off + retries)
 *   client-abort → "server_error"
 *   other        → "server_error"
 *
 * Shutdown is intentionally mapped to `server_error` (not a distinct type): the
 * OpenAI wire has no "overloaded" shape, and a 5xx-class `server_error` already
 * signals a retryable transient condition. This is asserted by the streaming
 * shutdown tests.
 *
 * Split from {@link streamErrorToOpenAIErrorType} so the v4 codec's
 * `formatError(kind)` (which receives the pre-classified `ClassifiedStreamError`,
 * not the raw error) shares the exact same mapping — no drift between the legacy
 * handler path and the codec path.
 */
export function streamErrorKindToOpenAIErrorType(kind: StreamErrorKind): string {
  switch (kind) {
    // Both are our own clocks running out, so both say timeout rather than hiding
    // behind the generic server_error bucket.
    case "idle-timeout":
    case "request-deadline": {
      return "timeout_error"
    }
    default: {
      // shutdown / client-abort / other → 5xx-class transient.
      return "server_error"
    }
  }
}

/**
 * OpenAI SSE `error.type` for a streaming lifecycle error. Thin wrapper that
 * classifies the raw error then maps the kind (see {@link streamErrorKindToOpenAIErrorType}).
 */
export function streamErrorToOpenAIErrorType(error: unknown): string {
  return streamErrorKindToOpenAIErrorType(classifyStreamError(error))
}

/**
 * Build the OpenAI-shaped SSE error frame for a streaming lifecycle error — used by BOTH the
 * mid-stream throw (H3) and the clean-drain truncation paths of the Chat Completions + Responses
 * (HTTP) handlers. Single source for the `{error:{message,type}}` frame shape so the four sites
 * (CC H3 / CC truncation / Responses H3 / Responses truncation) cannot drift apart.
 *
 * The Responses-WS path does NOT use this — its error/truncation terminator is the transport-coupled
 * `sendErrorAndClose` (1011 close), which cannot be modeled as a written frame — but it derives the
 * same `type` via {@link streamErrorToOpenAIErrorType}, so the classification stays unified.
 */
export function openAIStreamErrorFrame(error: unknown): SseFrame {
  return {
    event: "error",
    data: JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: streamErrorToOpenAIErrorType(error) } }),
  }
}
