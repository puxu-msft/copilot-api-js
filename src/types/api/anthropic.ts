/**
 * Anthropic API Types
 *
 * Content block types, stream events, and response types are imported from
 * the `@anthropic-ai/sdk`. Request payload and tool types remain our own
 * definitions since Copilot proxies arbitrary model names (not SDK's literal
 * union) and adds extensions (context_management, copilot_annotations).
 */

// ============================================================================
// Re-export SDK types
// ============================================================================

// Response content blocks
export type {
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
} from "@anthropic-ai/sdk/resources/messages"

// Request content blocks
export type {
  ContentBlockParam,
  TextBlockParam,
  ImageBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages"

// Messages
export type { MessageParam, Message } from "@anthropic-ai/sdk/resources/messages"

// Thinking & cache
export type { ThinkingConfigParam, CacheControlEphemeral } from "@anthropic-ai/sdk/resources/messages"

// Stream events
export type {
  RawMessageStartEvent,
  RawMessageStopEvent,
  RawContentBlockStartEvent,
  RawContentBlockStopEvent,
  RawMessageDeltaEvent,
  RawContentBlockDelta,
} from "@anthropic-ai/sdk/resources/messages"

// Internal-only SDK imports (not re-exported)
import type {
  ContentBlock,
  ContentBlockParam,
  TextBlockParam,
  MessageParam,
  ThinkingConfigParam,
  CacheControlEphemeral,
  WebSearchToolResultBlock,
  ToolResultBlockParam,
  RawContentBlockDeltaEvent,
  RawMessageStartEvent,
  RawMessageStopEvent,
  RawMessageDeltaEvent,
  RawContentBlockStartEvent,
  RawContentBlockStopEvent,
} from "@anthropic-ai/sdk/resources/messages"

// ============================================================================
// Request payload (our own — SDK uses Model literal union, we proxy strings)
// ============================================================================

export interface MessagesPayload {
  model: string
  max_tokens: number
  messages: MessageParam[]
  system?: string | TextBlockParam[]
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: Tool[]
  tool_choice?: ToolChoice
  thinking?: ThinkingConfigParam
  metadata?: { user_id?: string }
  context_management?: Record<string, unknown>
}

export interface Tool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  cache_control?: CacheControlEphemeral
  type?: string
  defer_loading?: boolean
}

export type ToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string }

// ============================================================================
// Message subtypes (narrow role for cast convenience)
// ============================================================================

export interface UserMessage {
  role: "user"
  content: string | ContentBlockParam[]
}

export interface AssistantMessage {
  role: "assistant"
  content: string | ContentBlock[]
}

// ============================================================================
// Copilot Extensions (not part of the Anthropic API)
// ============================================================================

export interface CopilotIPCodeCitation {
  url: string
  license: string
  repository: string
  start_line: number
  end_line: number
}

/** Copilot-specific annotations attached to SSE content block deltas */
export interface CopilotAnnotations {
  ip_code_citations?: CopilotIPCodeCitation[]
}

/** Content block delta event with Copilot annotations extension */
type CopilotContentBlockDeltaEvent = RawContentBlockDeltaEvent & {
  copilot_annotations?: CopilotAnnotations
}

export interface StreamPingEvent {
  type: "ping"
}

export interface StreamErrorEvent {
  type: "error"
  error: { type: string; message: string }
}

/** Stream event union — replaces SDK's delta event with our Copilot-extended version */
export type StreamEvent =
  | RawMessageStartEvent
  | RawMessageStopEvent
  | RawMessageDeltaEvent
  | RawContentBlockStartEvent
  | RawContentBlockStopEvent
  | CopilotContentBlockDeltaEvent
  | StreamPingEvent
  | StreamErrorEvent

// ============================================================================
// Type guards
// ============================================================================

/** Type guard for ToolResultBlockParam */
export function isToolResultBlock(
  block: ContentBlockParam,
): block is ToolResultBlockParam {
  return (block as ToolResultBlockParam).type === "tool_result"
}

/** Type guard for WebSearchToolResultBlock */
export function isServerToolResultBlock(
  block: ContentBlockParam | ContentBlock,
): block is WebSearchToolResultBlock {
  return (block as WebSearchToolResultBlock).type === "web_search_tool_result"
}
