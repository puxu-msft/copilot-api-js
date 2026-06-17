/**
 * Map streaming lifecycle errors to OpenAI-shaped SSE `error.type` strings.
 *
 * Shared by the Chat Completions and Responses streaming handlers so all three
 * surfaces (chat-completions, responses, responses fallback) classify a
 * shutdown / idle-timeout / other failure identically.
 */

import type { StreamErrorKind } from "~/lib/stream"

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
    case "idle-timeout": {
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
