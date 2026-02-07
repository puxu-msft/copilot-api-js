/**
 * Stream accumulator for Anthropic format responses.
 * Handles accumulating stream events for history recording and tracking.
 */

import type {
  AnthropicCopilotAnnotations,
  AnthropicMessageStartEvent,
  AnthropicStreamEventData,
} from "~/types/api/anthropic"

/** Stream accumulator for Anthropic format */
export interface AnthropicStreamAccumulator {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  stopReason: string
  content: string
  thinkingContent: string
  toolCalls: Array<{ id: string; name: string; input: string; blockType: "tool_use" | "server_tool_use" }>
  currentToolCall: { id: string; name: string; input: string; blockType: "tool_use" | "server_tool_use" } | null
  /** Tracks the type of the current content block being streamed */
  currentBlockType: "text" | "thinking" | "tool_use" | "server_tool_use" | null
  /** Copilot-specific: IP code citations collected from stream events */
  copilotAnnotations: Array<AnthropicCopilotAnnotations>
}

export function createAnthropicStreamAccumulator(): AnthropicStreamAccumulator {
  return {
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    stopReason: "",
    content: "",
    thinkingContent: "",
    toolCalls: [],
    currentToolCall: null,
    currentBlockType: null,
    copilotAnnotations: [],
  }
}

// Process a single Anthropic event for accumulation
export function processAnthropicEvent(event: AnthropicStreamEventData, acc: AnthropicStreamAccumulator) {
  switch (event.type) {
    case "message_start": {
      handleMessageStart(event.message, acc)
      break
    }
    case "content_block_delta": {
      handleContentBlockDelta(event.delta, acc, event.copilot_annotations)
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

// ============================================================================
// message_start handler
// ============================================================================

/**
 * Handle message_start event.
 * This is where input_tokens, model, and cache stats are first reported.
 */
function handleMessageStart(message: AnthropicMessageStartEvent["message"], acc: AnthropicStreamAccumulator) {
  if (message.model) acc.model = message.model
  acc.inputTokens = message.usage.input_tokens
  acc.outputTokens = message.usage.output_tokens
  if (message.usage.cache_read_input_tokens) {
    acc.cacheReadTokens = message.usage.cache_read_input_tokens
  }
  if (message.usage.cache_creation_input_tokens) {
    acc.cacheCreationTokens = message.usage.cache_creation_input_tokens
  }
}

// ============================================================================
// content_block handlers
// ============================================================================

// Content block delta types
type ContentBlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }

function handleContentBlockDelta(
  delta: ContentBlockDelta,
  acc: AnthropicStreamAccumulator,
  copilotAnnotations?: AnthropicCopilotAnnotations,
) {
  if (delta.type === "text_delta") {
    acc.content += delta.text
  } else if (delta.type === "thinking_delta") {
    acc.thinkingContent += delta.thinking
  } else if (delta.type === "input_json_delta" && acc.currentToolCall) {
    acc.currentToolCall.input += delta.partial_json
  }
  // signature_delta is not accumulated (it's part of the thinking block integrity, not content)

  // Collect Copilot-specific IP code citations
  if (copilotAnnotations?.IPCodeCitations?.length) {
    acc.copilotAnnotations.push(copilotAnnotations)
  }
}

// Content block types
type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use"
      id: string
      name: string
      input: Record<string, unknown>
    }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "server_tool_use"; id: string; name: string }

function handleContentBlockStart(block: ContentBlock, acc: AnthropicStreamAccumulator) {
  if (block.type === "redacted_thinking") {
    acc.currentBlockType = null
  } else if (block.type === "server_tool_use") {
    acc.currentBlockType = "server_tool_use"
    acc.currentToolCall = {
      id: block.id,
      name: block.name,
      input: "",
      blockType: "server_tool_use",
    }
  } else {
    acc.currentBlockType = block.type
  }

  if (block.type === "tool_use") {
    acc.currentToolCall = {
      id: block.id,
      name: block.name,
      input: "",
      blockType: "tool_use",
    }
  }
}

function handleContentBlockStop(acc: AnthropicStreamAccumulator) {
  if (acc.currentToolCall) {
    acc.toolCalls.push(acc.currentToolCall)
    acc.currentToolCall = null
  }
  acc.currentBlockType = null
}

// ============================================================================
// message_delta handler
// ============================================================================

// Message delta types
interface MessageDelta {
  stop_reason?: string | null
  stop_sequence?: string | null
}

interface MessageDeltaUsage {
  input_tokens?: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/**
 * Handle message_delta event.
 * output_tokens is the final count here (replaces message_start's 0).
 * input_tokens may or may not be present — only update if provided.
 */
function handleMessageDelta(
  delta: MessageDelta,
  usage: MessageDeltaUsage | undefined,
  acc: AnthropicStreamAccumulator,
) {
  if (delta.stop_reason) acc.stopReason = delta.stop_reason
  if (usage) {
    // output_tokens in message_delta is the final output count
    acc.outputTokens = usage.output_tokens
    // input_tokens in message_delta is optional; only override if explicitly present
    if (usage.input_tokens !== undefined) {
      acc.inputTokens = usage.input_tokens
    }
    // Accumulate cache stats if present (may complement message_start values)
    if (usage.cache_read_input_tokens !== undefined) {
      acc.cacheReadTokens = usage.cache_read_input_tokens
    }
    if (usage.cache_creation_input_tokens !== undefined) {
      acc.cacheCreationTokens = usage.cache_creation_input_tokens
    }
  }
}
