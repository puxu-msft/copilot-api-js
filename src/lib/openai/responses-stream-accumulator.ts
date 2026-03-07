/**
 * Stream accumulator for Responses API format.
 * Accumulates semantic SSE events into a final state for history/tracking.
 */

import type { BaseStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import type { ResponsesStreamEvent } from "~/types/api/openai-responses"

/** Internal tool call accumulator using string array to avoid O(n²) concatenation */
interface ToolCallAccumulator {
  id: string
  callId: string
  name: string
  argumentParts: Array<string>
}

/** Stream accumulator for Responses API format */
export interface ResponsesStreamAccumulator extends BaseStreamAccumulator {
  status: string
  responseId: string
  toolCalls: Array<{ id: string; callId: string; name: string; arguments: string }>
  /** Tool call accumulators indexed by output_index */
  toolCallMap: Map<number, ToolCallAccumulator>
  /** Text content parts for O(1) accumulation, joined on read via finalContent() */
  contentParts: Array<string>
  /** Reasoning output tokens (from output_tokens_details) */
  reasoningTokens: number
  /** Cached input tokens (from input_tokens_details) */
  cachedInputTokens: number
}

export function createResponsesStreamAccumulator(): ResponsesStreamAccumulator {
  return {
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    content: "",
    status: "",
    responseId: "",
    toolCalls: [],
    toolCallMap: new Map(),
    contentParts: [],
    reasoningTokens: 0,
    cachedInputTokens: 0,
  }
}

/** Get the final accumulated content string */
export function finalizeResponsesContent(acc: ResponsesStreamAccumulator): string {
  if (acc.contentParts.length > 0) {
    acc.content = acc.contentParts.join("")
    acc.contentParts = []
  }
  return acc.content
}

/** Accumulate a single parsed Responses API event into the accumulator */
export function accumulateResponsesStreamEvent(event: ResponsesStreamEvent, acc: ResponsesStreamAccumulator) {
  switch (event.type) {
    case "response.created":
    case "response.in_progress": {
      if (event.response.model) acc.model = event.response.model
      if (event.response.id) acc.responseId = event.response.id
      break
    }

    case "response.completed": {
      acc.status = event.response.status
      if (event.response.model) acc.model = event.response.model
      if (event.response.usage) {
        acc.inputTokens = event.response.usage.input_tokens
        acc.outputTokens = event.response.usage.output_tokens
        acc.reasoningTokens = event.response.usage.output_tokens_details?.reasoning_tokens ?? 0
        acc.cachedInputTokens = event.response.usage.input_tokens_details?.cached_tokens ?? 0
      }
      break
    }

    case "response.failed":
    case "response.incomplete": {
      acc.status = event.response.status
      break
    }

    case "response.output_item.added": {
      if (event.item.type === "function_call") {
        acc.toolCallMap.set(event.output_index, {
          id: event.item.id,
          callId: "call_id" in event.item ? event.item.call_id : "",
          name: "name" in event.item ? event.item.name : "",
          argumentParts: [],
        })
      }
      break
    }

    case "response.output_text.delta": {
      acc.contentParts.push(event.delta)
      break
    }

    case "response.function_call_arguments.delta": {
      const tcAcc = acc.toolCallMap.get(event.output_index)
      if (tcAcc) {
        tcAcc.argumentParts.push(event.delta)
      }
      break
    }

    case "response.function_call_arguments.done": {
      const tcAcc = acc.toolCallMap.get(event.output_index)
      if (tcAcc) {
        acc.toolCalls.push({
          id: tcAcc.id,
          callId: tcAcc.callId,
          name: tcAcc.name,
          arguments: tcAcc.argumentParts.join(""),
        })
      }
      break
    }

    case "response.output_item.done": {
      // Final output item — if it's a function call that wasn't already finalized
      // via arguments.done, finalize it now
      if (event.item.type === "function_call") {
        const existing = acc.toolCalls.find((tc) => tc.id === event.item.id)
        if (!existing) {
          acc.toolCalls.push({
            id: event.item.id,
            callId: "call_id" in event.item ? event.item.call_id : "",
            name: "name" in event.item ? event.item.name : "",
            arguments: "arguments" in event.item ? event.item.arguments : "",
          })
        }
      }
      break
    }

    // Other events don't need accumulation
    default: {
      break
    }
  }
}
