/** Shared recording utilities for streaming responses */

import consola from "consola"

import type { AnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import type { ResponseData } from "~/lib/context/request"
import type { ResponsesStreamAccumulator } from "~/lib/openai/responses-stream-accumulator"
import type { OpenAIStreamAccumulator } from "~/lib/openai/stream-accumulator"

import { finalizeResponsesContent } from "~/lib/openai/responses-stream-accumulator"

import { safeParseJson } from "./response"

/**
 * Map Anthropic content blocks to history-friendly format.
 */
function mapAnthropicContentBlocks(acc: AnthropicStreamAccumulator): Array<unknown> {
  return acc.contentBlocks.map((block) => {
    // Generic (unknown) blocks are passed through as-is
    if ("_generic" in block) {
      const { _generic: _, ...rest } = block
      return rest
    }

    // Server tool result blocks (web_search_tool_result, tool_search_tool_result, etc.)
    // Check before the type switch because _brand blocks have `type: string` which
    // would overlap with literal type cases.
    if ("_brand" in block) {
      return {
        type: block.type,
        tool_use_id: block.tool_use_id,
        content: block.content,
      }
    }

    // After the _generic and _brand checks, only known block types remain.
    // Use a type assertion to narrow — TypeScript can't infer this from the
    // _brand / _generic guards since they aren't shared discriminant properties.
    type KnownBlock =
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string; signature?: string }
      | { type: "redacted_thinking"; data: string }
      | { type: "tool_use"; id: string; name: string; input: string }
      | { type: "server_tool_use"; id: string; name: string; input: string }
    const narrowed = block as KnownBlock

    switch (narrowed.type) {
      case "text": {
        return { type: "text" as const, text: narrowed.text }
      }
      case "thinking": {
        return { type: "thinking" as const, thinking: narrowed.thinking }
      }
      case "redacted_thinking": {
        return { type: "redacted_thinking" as const }
      }
      case "tool_use":
      case "server_tool_use": {
        return {
          type: narrowed.type as string,
          id: narrowed.id,
          name: narrowed.name,
          input: safeParseJson(narrowed.input),
        }
      }
      default: {
        const unknown = narrowed as { type: string }
        consola.warn(`[recording] Unhandled content block type in stream result: ${unknown.type}`)
        return { type: unknown.type }
      }
    }
  })
}

/**
 * Build a ResponseData from a completed Anthropic stream accumulator.
 * Does not include durationMs or queueWaitMs — those are tracked by RequestContext.
 */
export function buildAnthropicResponseData(acc: AnthropicStreamAccumulator, fallbackModel: string): ResponseData {
  const contentBlocks = mapAnthropicContentBlocks(acc)

  return {
    success: true,
    model: acc.model || fallbackModel,
    usage: {
      input_tokens: acc.inputTokens,
      output_tokens: acc.outputTokens,
      ...(acc.cacheReadTokens > 0 && { cache_read_input_tokens: acc.cacheReadTokens }),
      ...(acc.cacheCreationTokens > 0 && { cache_creation_input_tokens: acc.cacheCreationTokens }),
    },
    stop_reason: acc.stopReason || undefined,
    content: contentBlocks.length > 0 ? { role: "assistant", content: contentBlocks } : null,
  }
}

/**
 * Build a ResponseData from a completed OpenAI stream accumulator.
 * Does not include durationMs or queueWaitMs — those are tracked by RequestContext.
 */
export function buildOpenAIResponseData(acc: OpenAIStreamAccumulator, fallbackModel: string): ResponseData {
  // Collect tool calls from map, joining accumulated argument parts
  for (const tc of acc.toolCallMap.values()) {
    if (tc.id && tc.name) acc.toolCalls.push({ id: tc.id, name: tc.name, arguments: tc.argumentParts.join("") })
  }

  const toolCalls = acc.toolCalls.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.arguments },
  }))

  return {
    success: true,
    model: acc.model || fallbackModel,
    usage: {
      input_tokens: acc.inputTokens,
      output_tokens: acc.outputTokens,
      ...(acc.reasoningTokens > 0 && {
        output_tokens_details: { reasoning_tokens: acc.reasoningTokens },
      }),
      ...(acc.cachedTokens > 0 && { cache_read_input_tokens: acc.cachedTokens }),
    },
    stop_reason: acc.finishReason || undefined,
    content: {
      role: "assistant",
      content: acc.content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    },
  }
}

/**
 * Build a ResponseData from a completed Responses API stream accumulator.
 * Converts tool calls from Responses format (callId) to OpenAI Chat Completions format (id).
 */
export function buildResponsesResponseData(acc: ResponsesStreamAccumulator, fallbackModel: string): ResponseData {
  // Finalize tool calls from the accumulator map
  for (const tcAcc of acc.toolCallMap.values()) {
    const existing = acc.toolCalls.find((tc) => tc.id === tcAcc.id)
    if (!existing && tcAcc.id && tcAcc.name) {
      acc.toolCalls.push({
        id: tcAcc.id,
        callId: tcAcc.callId,
        name: tcAcc.name,
        arguments: tcAcc.argumentParts.join(""),
      })
    }
  }

  const finalContent = finalizeResponsesContent(acc)

  const toolCalls = acc.toolCalls.map((tc) => ({
    id: tc.callId || tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.arguments },
  }))

  return {
    success: true,
    model: acc.model || fallbackModel,
    usage: {
      input_tokens: acc.inputTokens,
      output_tokens: acc.outputTokens,
      ...(acc.reasoningTokens > 0 && {
        output_tokens_details: { reasoning_tokens: acc.reasoningTokens },
      }),
      ...(acc.cachedInputTokens > 0 && { cache_read_input_tokens: acc.cachedInputTokens }),
    },
    stop_reason: acc.status || undefined,
    content:
      finalContent || toolCalls.length > 0 ?
        {
          role: "assistant",
          content: finalContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        }
      : null,
  }
}
