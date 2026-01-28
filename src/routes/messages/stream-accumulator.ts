/**
 * Stream accumulator for Anthropic format responses.
 * Handles accumulating stream events for history recording and tracking.
 */

import type { AnthropicStreamEventData } from "~/types/api/anthropic"

/** Stream accumulator for Anthropic format */
export interface AnthropicStreamAccumulator {
  model: string
  inputTokens: number
  outputTokens: number
  stopReason: string
  content: string
  toolCalls: Array<{ id: string; name: string; input: string }>
  currentToolCall: { id: string; name: string; input: string } | null
}

export function createAnthropicStreamAccumulator(): AnthropicStreamAccumulator {
  return {
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    stopReason: "",
    content: "",
    toolCalls: [],
    currentToolCall: null,
  }
}

// Process a single Anthropic event for accumulation
export function processAnthropicEvent(
  event: AnthropicStreamEventData,
  acc: AnthropicStreamAccumulator,
) {
  switch (event.type) {
    case "content_block_delta": {
      handleContentBlockDelta(event.delta, acc)
      break
    }
    case "content_block_start": {
      handleContentBlockStart(event.content_block, acc)
      break
    }
    case "content_block_stop": {
      handleContentBlockStop(acc)
      break
    }
    case "message_delta": {
      handleMessageDelta(event.delta, event.usage, acc)
      break
    }
    default: {
      break
    }
  }
}

// Content block delta types
type ContentBlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }

function handleContentBlockDelta(
  delta: ContentBlockDelta,
  acc: AnthropicStreamAccumulator,
) {
  if (delta.type === "text_delta") {
    acc.content += delta.text
  } else if (delta.type === "input_json_delta" && acc.currentToolCall) {
    acc.currentToolCall.input += delta.partial_json
  }
  // thinking_delta and signature_delta are ignored for accumulation
}

// Content block types from anthropic-types.ts
type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use"
      id: string
      name: string
      input: Record<string, unknown>
    }
  | { type: "thinking"; thinking: string }

function handleContentBlockStart(
  block: ContentBlock,
  acc: AnthropicStreamAccumulator,
) {
  if (block.type === "tool_use") {
    acc.currentToolCall = {
      id: block.id,
      name: block.name,
      input: "",
    }
  }
}

function handleContentBlockStop(acc: AnthropicStreamAccumulator) {
  if (acc.currentToolCall) {
    acc.toolCalls.push(acc.currentToolCall)
    acc.currentToolCall = null
  }
}

// Message delta types
interface MessageDelta {
  stop_reason?: string | null
  stop_sequence?: string | null
}

interface MessageUsage {
  input_tokens?: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

function handleMessageDelta(
  delta: MessageDelta,
  usage: MessageUsage | undefined,
  acc: AnthropicStreamAccumulator,
) {
  if (delta.stop_reason) acc.stopReason = delta.stop_reason
  if (usage) {
    acc.inputTokens = usage.input_tokens ?? 0
    acc.outputTokens = usage.output_tokens
  }
}
