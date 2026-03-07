/**
 * Deferred tool retry strategy.
 *
 * Handles 400 errors caused by deferred tools being referenced in the request
 * (e.g., in message history) before they've been loaded via tool_search.
 *
 * When context_management clears older tool_search activations but keeps
 * tool_use/tool_result pairs, or when the client compacts history, a deferred
 * tool may appear in the conversation without its tool_search "load" record.
 * The API then rejects the request with:
 *   "Tool reference 'X' not found in available tools"
 *
 * This strategy parses the tool name from the error, marks it as non-deferred
 * (defer_loading: false) in the payload's tools array, and retries.
 */

import consola from "consola"

import type { ApiError } from "~/lib/error"
import type { Tool } from "~/types/api/anthropic"

import type { RetryAction, RetryContext, RetryStrategy } from "../pipeline"

// ============================================================================
// Error parsing
// ============================================================================

/** Pattern: "Tool reference 'tool_name' not found in available tools" */
const TOOL_REFERENCE_NOT_FOUND_PATTERN = /Tool reference '([^']+)' not found in available tools/

/**
 * Extract tool name from a "Tool reference not found" error.
 * Returns the tool name or null if the error doesn't match.
 */
export function parseToolReferenceError(message: string): string | null {
  const match = TOOL_REFERENCE_NOT_FOUND_PATTERN.exec(message)
  return match?.[1] ?? null
}

// ============================================================================
// Strategy
// ============================================================================

/**
 * Create a deferred tool retry strategy.
 *
 * When the API rejects a request because a deferred tool is referenced
 * in the message history, this strategy un-defers that tool and retries.
 */
export function createDeferredToolRetryStrategy<TPayload extends { tools?: Array<Tool> }>(): RetryStrategy<TPayload> {
  // Track tool names that have already been un-deferred across retries
  // to avoid infinite retry loops on the same tool
  const undeferredTools = new Set<string>()

  return {
    name: "deferred-tool-retry",

    canHandle(error: ApiError): boolean {
      if (error.type !== "bad_request" || error.status !== 400) return false

      const raw = error.raw
      if (!raw || typeof raw !== "object" || !("responseText" in raw)) return false

      const responseText = (raw as { responseText: string }).responseText
      const toolName = parseToolReferenceFromResponse(responseText)
      if (!toolName) return false

      // Only handle if we haven't already retried for this tool
      return !undeferredTools.has(toolName)
    },

    handle(error: ApiError, currentPayload: TPayload, context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      const raw = error.raw as { responseText: string }
      const toolName = parseToolReferenceFromResponse(raw.responseText)

      if (!toolName || !currentPayload.tools) {
        return Promise.resolve({ action: "abort", error })
      }

      consola.debug(
        `[DeferredToolRetry] Tool "${toolName}" error.`
          + ` Payload has ${currentPayload.tools.length} tools: [${currentPayload.tools.map((t) => t.name).join(", ")}]`,
      )

      // Find the tool in the payload
      const toolIndex = currentPayload.tools.findIndex((t) => t.name === toolName)

      if (toolIndex === -1) {
        // Safety net: tool may not be in the pipeline-visible payload
        // (e.g. preprocessTools wasn't called, or sanitize removed it).
        // Inject a minimal stub with no defer_loading so the API accepts
        // the tool_use reference on retry.
        consola.debug(`[DeferredToolRetry] Tool "${toolName}" not in payload, injecting non-deferred stub`)
        undeferredTools.add(toolName)

        const newTools = [
          ...currentPayload.tools,
          {
            name: toolName,
            description: "Tool referenced in conversation history",
            input_schema: { type: "object" as const, properties: {} },
          },
        ]

        return Promise.resolve({
          action: "retry",
          payload: { ...currentPayload, tools: newTools } as TPayload,
        })
      }

      // Mark as un-deferred and track it
      undeferredTools.add(toolName)

      const newTools = [...currentPayload.tools]
      newTools[toolIndex] = { ...newTools[toolIndex], defer_loading: false }

      consola.info(
        `[DeferredToolRetry] Attempt ${context.attempt + 1}/${context.maxRetries + 1}: `
          + `Un-deferring tool "${toolName}" and retrying`,
      )

      return Promise.resolve({
        action: "retry",
        payload: { ...currentPayload, tools: newTools },
        meta: { undeferredTool: toolName },
      })
    },
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Parse tool name from the error response JSON */
function parseToolReferenceFromResponse(responseText: string): string | null {
  try {
    const parsed = JSON.parse(responseText) as { error?: { message?: string } }
    const message = parsed.error?.message
    if (!message) return null
    return parseToolReferenceError(message)
  } catch {
    // Try raw text match as fallback
    return parseToolReferenceError(responseText)
  }
}
