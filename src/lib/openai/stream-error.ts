/**
 * Map streaming lifecycle errors to OpenAI-shaped SSE `error.type` strings.
 *
 * Shared by the Chat Completions and Responses streaming handlers so all three
 * surfaces (chat-completions, responses, responses fallback) classify a
 * shutdown / idle-timeout / other failure identically.
 */

import { classifyStreamError } from "~/lib/stream"

/**
 * OpenAI SSE `error.type` for a streaming lifecycle error.
 *   idle-timeout → "timeout_error"
 *   shutdown     → "server_error" (5xx-class transient — client backs off + retries)
 *   other        → "server_error"
 *
 * Shutdown is intentionally mapped to `server_error` (not a distinct type): the
 * OpenAI wire has no "overloaded" shape, and a 5xx-class `server_error` already
 * signals a retryable transient condition. This is asserted by the streaming
 * shutdown tests.
 */
export function streamErrorToOpenAIErrorType(error: unknown): string {
  switch (classifyStreamError(error)) {
    case "idle-timeout": {
      return "timeout_error"
    }
    case "shutdown": {
      // 5xx-class transient — client backs off + retries against the restart.
      return "server_error"
    }
    default: {
      return "server_error"
    }
  }
}
