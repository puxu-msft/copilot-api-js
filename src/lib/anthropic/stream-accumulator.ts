/**
 * Stream accumulator for Anthropic format responses.
 * Handles accumulating stream events for history recording and tracking.
 */

import consola from "consola"

import type { CopilotAnnotations, StreamEvent, RawMessageStartEvent } from "~/types/api/anthropic"

import { isServerToolResultType } from "./server-tool-filter"

// ============================================================================
// Accumulated content block types
// ============================================================================

/**
 * A single content block accumulated from the stream, preserving original order.
 * Known block types have typed variants; unknown types are stored via
 * AccumulatedGenericBlock with all original fields preserved.
 */
export type AccumulatedContentBlock =
  | AccumulatedTextBlock
  | AccumulatedThinkingBlock
  | AccumulatedRedactedThinkingBlock
  | AccumulatedToolUseBlock
  | AccumulatedServerToolUseBlock
  | AccumulatedServerToolResultBlock
  | AccumulatedGenericBlock

export interface AccumulatedTextBlock {
  type: "text"
  text: string
}
export interface AccumulatedThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
}
export interface AccumulatedRedactedThinkingBlock {
  type: "redacted_thinking"
  data: string
}
export interface AccumulatedToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: string
}
export interface AccumulatedServerToolUseBlock {
  type: "server_tool_use"
  id: string
  name: string
  input: string
}

/**
 * Server-side tool result block (web_search_tool_result, tool_search_tool_result,
 * code_execution_tool_result, etc.). Branded with `_serverToolResult` to
 * distinguish from AccumulatedGenericBlock in type checks.
 *
 * Uses `_brand` discriminant to enable TypeScript union narrowing against
 * known literal-typed block variants.
 */
export interface AccumulatedServerToolResultBlock {
  _brand: "server_tool_result"
  type: string
  tool_use_id: string
  content: unknown
}

/**
 * Generic block for unknown/future content block types.
 * Branded with `_generic` to distinguish from known types in discriminated unions.
 */
export interface AccumulatedGenericBlock {
  type: string
  _generic: true
  [key: string]: unknown
}

// ============================================================================
// Base accumulator interface (shared with OpenAI accumulator)
// ============================================================================

/** Minimal accumulator contract for tracking and error recording */
export interface BaseStreamAccumulator {
  model: string
  inputTokens: number
  outputTokens: number
  /** Plain text content accumulated from text deltas (error recording fallback) */
  rawContent: string
}

// ============================================================================
// Anthropic stream accumulator
// ============================================================================

/** Stream accumulator for Anthropic format */
export interface AnthropicStreamAccumulator extends BaseStreamAccumulator {
  cacheReadTokens: number
  cacheCreationTokens: number
  stopReason: string
  /** Content blocks in stream order, indexed by the event's `index` field. */
  contentBlocks: Array<AccumulatedContentBlock>
  /** Copilot-specific: IP code citations collected from stream events */
  copilotAnnotations: Array<CopilotAnnotations>
  /** Error received from stream, if any */
  streamError?: { type: string; message: string }
  /** Server-side tool search request count from usage.server_tool_use */
  toolSearchRequests: number
}

/** Create a fresh Anthropic stream accumulator */
export function createAnthropicStreamAccumulator(): AnthropicStreamAccumulator {
  return {
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    stopReason: "",
    rawContent: "",
    contentBlocks: [],
    copilotAnnotations: [],
    toolSearchRequests: 0,
  }
}

// ============================================================================
// Event processing
// ============================================================================

/** Accumulate a single Anthropic stream event into the accumulator */
export function accumulateAnthropicStreamEvent(event: StreamEvent, acc: AnthropicStreamAccumulator) {
  switch (event.type) {
    case "message_start": {
      handleMessageStart(event.message, acc)
      break
    }
    case "content_block_start": {
      handleContentBlockStart(event.index, event.content_block as unknown as AccContentBlock, acc)
      break
    }
    case "content_block_delta": {
      handleContentBlockDelta(event.index, event.delta as AccDelta, acc, event.copilot_annotations)
      break
    }
    case "content_block_stop": {
      // Nothing to do — block is already stored by index, no state to clear
      break
    }
    case "message_delta": {
      handleMessageDelta(event.delta as MessageDelta, event.usage as MessageDeltaUsage, acc)
      break
    }
    case "message_stop": {
      // Nothing to do — stop_reason is provided in message_delta, no state to clear
      break
    }
    case "ping": {
      // No accumulation needed for ping events, but could track last ping time if desired
      break
    }
    case "error": {
      const err = (event as { error?: { type?: string; message?: string } }).error
      acc.streamError = {
        type: err?.type ?? "unknown_error",
        message: err?.message ?? "Unknown stream error",
      }
      break
    }
    default: {
      consola.warn(`[stream-accumulator] Unknown event type: ${(event as { type: string }).type}`)
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
function handleMessageStart(message: RawMessageStartEvent["message"], acc: AnthropicStreamAccumulator) {
  if (message.model) acc.model = message.model
  acc.inputTokens = message.usage.input_tokens
  acc.outputTokens = message.usage.output_tokens
  if (message.usage.cache_read_input_tokens) {
    acc.cacheReadTokens = message.usage.cache_read_input_tokens
  }
  if (message.usage.cache_creation_input_tokens) {
    acc.cacheCreationTokens = message.usage.cache_creation_input_tokens
  }
  // Server-side tool search usage
  const serverToolUse = (message.usage as unknown as Record<string, unknown>).server_tool_use as
    | { tool_search_requests?: number }
    | undefined
  if (serverToolUse?.tool_search_requests) {
    acc.toolSearchRequests = serverToolUse.tool_search_requests
  }
}

// ============================================================================
// content_block handlers
// ============================================================================

/** Content block delta types (local — looser than SDK's RawContentBlockDelta for proxy use) */
type AccDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }

/**
 * Content block start — accepts any record from the SSE stream.
 * Known types are narrowed inside handleContentBlockStart; unknown types
 * are stored via AccumulatedGenericBlock or AccumulatedServerToolResultBlock.
 */
type AccContentBlock = Record<string, unknown> & { type: string }

function handleContentBlockStart(index: number, block: AccContentBlock, acc: AnthropicStreamAccumulator) {
  let newBlock: AccumulatedContentBlock

  switch (block.type) {
    case "text": {
      newBlock = { type: "text", text: "" }
      break
    }
    case "thinking": {
      newBlock = { type: "thinking", thinking: "", signature: undefined }
      break
    }
    case "redacted_thinking": {
      // Complete at block_start, no subsequent deltas
      newBlock = { type: "redacted_thinking", data: block.data as string }
      break
    }
    case "tool_use": {
      newBlock = { type: "tool_use", id: block.id as string, name: block.name as string, input: "" }
      break
    }
    case "server_tool_use": {
      newBlock = { type: "server_tool_use", id: block.id as string, name: block.name as string, input: "" }
      break
    }
    default: {
      // Server tool result blocks (web_search_tool_result, tool_search_tool_result,
      // code_execution_tool_result, etc.) — complete at block_start, no subsequent deltas.
      if (isServerToolResultType(block.type) && "tool_use_id" in block) {
        newBlock = {
          _brand: "server_tool_result",
          type: block.type,
          tool_use_id: block.tool_use_id as string,
          content: block.content,
        }
        break
      }

      // Truly unknown block type — store all fields as-is for forward compatibility.
      consola.warn(`[stream-accumulator] Unknown content block type: ${block.type}`)
      newBlock = { ...block, _generic: true } as AccumulatedGenericBlock
      break
    }
  }

  acc.contentBlocks[index] = newBlock
}

function handleContentBlockDelta(
  index: number,
  delta: AccDelta,
  acc: AnthropicStreamAccumulator,
  copilotAnnotations?: CopilotAnnotations,
) {
  const block = acc.contentBlocks[index]
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: index from untrusted SSE data
  if (!block) return

  switch (delta.type) {
    case "text_delta": {
      const b = block as { text: string }
      b.text += delta.text
      acc.rawContent += delta.text // Sync BaseStreamAccumulator.rawContent for error fallback
      break
    }
    case "thinking_delta": {
      const b = block as { thinking: string }
      b.thinking += delta.thinking
      break
    }
    case "input_json_delta": {
      const b = block as { input: string }
      b.input += delta.partial_json
      break
    }
    case "signature_delta": {
      // signature_delta is part of the thinking block integrity, it's not accumulated actually (it, not content)
      const b = block as { signature?: string }
      if (b.signature) {
        consola.error(
          "[stream-accumulator] Received unexpected signature_delta for a block that already has a signature. Overwriting existing signature.",
        )
      }
      b.signature = delta.signature
      break
    }
    default: {
      consola.warn(`[stream-accumulator] Unknown delta type: ${(delta as { type: string }).type}`)
      break
    }
  }

  // Collect Copilot-specific IP code citations
  if (copilotAnnotations?.ip_code_citations?.length) {
    acc.copilotAnnotations.push(copilotAnnotations)
  }
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
  server_tool_use?: { tool_search_requests?: number }
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
    // Server-side tool search usage
    if (usage.server_tool_use?.tool_search_requests) {
      acc.toolSearchRequests = usage.server_tool_use.tool_search_requests
    }
  }
}

// ============================================================================
// Convenience extractors
// ============================================================================

/** Get concatenated text content from all text blocks */
export function getTextContent(acc: AnthropicStreamAccumulator): string {
  return acc.contentBlocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
}

/** Get concatenated thinking content from all thinking blocks */
export function getThinkingContent(acc: AnthropicStreamAccumulator): string {
  return acc.contentBlocks
    .filter((b): b is { type: "thinking"; thinking: string } => b.type === "thinking")
    .map((b) => b.thinking)
    .join("")
}

/** Get count of redacted_thinking blocks */
export function getRedactedThinkingCount(acc: AnthropicStreamAccumulator): number {
  return acc.contentBlocks.filter((b) => b.type === "redacted_thinking").length
}
