/**
 * Anthropic API Types
 * Centralized type definitions for Anthropic message format.
 */

// ============================================================================
// Request Types
// ============================================================================

export interface AnthropicMessagesPayload {
  model: string
  messages: Array<AnthropicMessage>
  max_tokens: number
  system?: string | Array<AnthropicTextBlock>
  metadata?: {
    user_id?: string
  }
  stop_sequences?: Array<string>
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: Array<AnthropicTool>
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none"
    name?: string
  }
  thinking?: {
    type: "enabled" | "disabled" | "adaptive"
    budget_tokens?: number
  }
  service_tier?: "auto" | "standard_only"
}

// ============================================================================
// Content Block Types
// ============================================================================

/** Cache control for prompt caching (read-only: we report cached_tokens but can't set cacheability) */
export interface AnthropicCacheControl {
  type: "ephemeral"
}

export interface AnthropicTextBlock {
  type: "text"
  text: string
  cache_control?: AnthropicCacheControl
}

export interface AnthropicImageBlock {
  type: "image"
  source: {
    type: "base64"
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    data: string
  }
  cache_control?: AnthropicCacheControl
}

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  // Content can be a string or an array of content blocks (text/image)
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>
  is_error?: boolean
  cache_control?: AnthropicCacheControl
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
  cache_control?: AnthropicCacheControl
}

export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
  /** Signature for verifying thinking block integrity when sent back in subsequent turns */
  signature?: string
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking"
  data: string
}

/** Server-side tool use block (e.g., web_search). Returned by API when server tools are invoked. */
export interface AnthropicServerToolUseBlock {
  type: "server_tool_use"
  id: string
  name: string
  input: Record<string, unknown>
  cache_control?: AnthropicCacheControl
}

/** Web search tool result block. Paired with server_tool_use in user messages. */
export interface AnthropicWebSearchToolResultBlock {
  type: "web_search_tool_result"
  tool_use_id: string
  content:
    | Array<{
        type: "web_search_result"
        url: string
        title: string
        encrypted_content: string
        page_age?: string
      }>
    | {
        type: "web_search_tool_result_error"
        error_code: string
      }
  cache_control?: AnthropicCacheControl
}

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock
  | AnthropicWebSearchToolResultBlock

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicServerToolUseBlock

/**
 * Check if a content block is a regular tool_result block.
 */
export function isToolResultBlock(block: { type: string }): block is { type: "tool_result"; tool_use_id: string } {
  return block.type === "tool_result"
}

/**
 * Check if a content block is a server tool result (paired with server_tool_use).
 * Matches web_search_tool_result, tool_search_tool_result, and any future server tool result
 * types that have a tool_use_id field but are NOT regular tool_result blocks.
 *
 * This uses runtime duck-typing because Anthropic can introduce new server tool result types
 * (e.g., tool_search_tool_result) that our static types don't cover yet.
 */
export function isServerToolResultBlock(block: { type: string }): block is { type: string; tool_use_id: string } {
  return block.type !== "tool_result" && block.type !== "text" && block.type !== "image" && "tool_use_id" in block
}

// ============================================================================
// Message Types
// ============================================================================

export interface AnthropicUserMessage {
  role: "user"
  content: string | Array<AnthropicUserContentBlock>
}

export interface AnthropicAssistantMessage {
  role: "assistant"
  content: string | Array<AnthropicAssistantContentBlock>
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage

// ============================================================================
// Tool Types
// ============================================================================

export interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  // Server-side tools have a type field like "web_search_20250305"
  type?: string
  // Tool search: defer loading for non-core tools (only loaded when model needs them)
  defer_loading?: boolean
}

// ============================================================================
// Response Types
// ============================================================================

export interface AnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  content: Array<AnthropicAssistantContentBlock>
  model: string
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal" | null
  stop_sequence: string | null
  usage: AnthropicUsage
}

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  service_tier?: "standard" | "priority" | "batch"
}

export type AnthropicResponseContentBlock = AnthropicAssistantContentBlock

// ============================================================================
// Copilot-Specific Types
// ============================================================================

/** IP Code Citations from Copilot API */
export interface AnthropicIPCodeCitation {
  start_index: number
  end_index: number
  license: string
  url: string
  repository: string
}

/** Copilot-specific annotations attached to SSE content block deltas */
export interface AnthropicCopilotAnnotations {
  IPCodeCitations?: Array<AnthropicIPCodeCitation>
}

// ============================================================================
// Stream Event Types
// ============================================================================

export interface AnthropicMessageStartEvent {
  type: "message_start"
  message: Omit<AnthropicResponse, "content" | "stop_reason" | "stop_sequence"> & {
    content: []
    stop_reason: null
    stop_sequence: null
  }
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start"
  index: number
  content_block:
    | { type: "text"; text: string }
    | (Omit<AnthropicToolUseBlock, "input"> & {
        input: Record<string, unknown>
      })
    | { type: "thinking"; thinking: string; signature?: string }
    | { type: "redacted_thinking"; data: string }
    | { type: "server_tool_use"; id: string; name: string }
}

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
  /** Copilot-specific: IP code citations attached to content deltas */
  copilot_annotations?: AnthropicCopilotAnnotations
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop"
  index: number
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta"
  delta: {
    stop_reason?: AnthropicResponse["stop_reason"]
    stop_sequence?: string | null
  }
  usage?: {
    input_tokens?: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  /** Server-side context management response (edits applied, tokens saved) */
  context_management?: {
    edits_applied?: Array<{
      type: string
      [key: string]: unknown
    }>
  }
}

export interface AnthropicMessageStopEvent {
  type: "message_stop"
}

export interface AnthropicPingEvent {
  type: "ping"
}

export interface AnthropicErrorEvent {
  type: "error"
  error: {
    type: string
    message: string
  }
}

export type AnthropicStreamEventData =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent

// ============================================================================
// Stream State (for translation)
// ============================================================================

export interface AnthropicStreamState {
  messageStartSent: boolean
  contentBlockIndex: number
  contentBlockOpen: boolean
  model?: string // Stores model from early chunks for later use
  toolCalls: {
    [openAIToolIndex: number]: {
      id: string
      name: string
      anthropicBlockIndex: number
    }
  }
}
