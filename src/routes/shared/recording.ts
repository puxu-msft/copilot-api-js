/** Shared recording utilities for streaming responses */

import type { AnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import type { OpenAIStreamAccumulator } from "~/lib/openai/stream-accumulator"

import { safeParseJson } from "./response"
import type { RequestResult, ResponseContext } from "./tracking"

/**
 * Build a RequestResult from a completed Anthropic stream accumulator.
 * Maps content blocks to history format.
 */
export function buildAnthropicStreamResult(
  acc: AnthropicStreamAccumulator,
  fallbackModel: string,
  ctx: ResponseContext,
): RequestResult {
  // Map contentBlocks to history format, preserving stream order
  const contentBlocks = acc.contentBlocks.map((block) => {
    // Generic (unknown) blocks are passed through as-is
    if ("_generic" in block) {
      const { _generic: _, ...rest } = block
      return rest
    }

    switch (block.type) {
      case "text":
        return { type: "text" as const, text: block.text }
      case "thinking":
        return { type: "thinking" as const, thinking: block.thinking }
      case "redacted_thinking":
        return { type: "redacted_thinking" as const }
      case "tool_use":
      case "server_tool_use":
        return {
          type: block.type as string,
          id: block.id,
          name: block.name,
          input: safeParseJson(block.input),
        }
      case "web_search_tool_result":
        return {
          type: "web_search_tool_result" as const,
          tool_use_id: block.tool_use_id,
          content: block.content,
        }
    }
  })

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
    durationMs: Date.now() - ctx.startTime,
    queueWaitMs: ctx.queueWaitMs,
  }
}

/** Build a RequestResult from a completed OpenAI stream accumulator */
export function buildOpenAIStreamResult(
  acc: OpenAIStreamAccumulator,
  fallbackModel: string,
  ctx: ResponseContext,
): RequestResult {
  // Collect tool calls from map
  for (const tc of acc.toolCallMap.values()) {
    if (tc.id && tc.name) acc.toolCalls.push(tc)
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
      ...(acc.cachedTokens > 0 && { cache_read_input_tokens: acc.cachedTokens }),
    },
    stop_reason: acc.finishReason || undefined,
    content: {
      role: "assistant",
      content: acc.content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    },
    durationMs: Date.now() - ctx.startTime,
    queueWaitMs: ctx.queueWaitMs,
  }
}
