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
  RedactedThinkingBlock,
  ServerToolUseBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  WebSearchToolResultBlock,
} from "@anthropic-ai/sdk/resources/messages"

// Request content blocks
export type {
  ContentBlockParam,
  ImageBlockParam,
  RedactedThinkingBlockParam,
  ServerToolUseBlockParam,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
  WebSearchToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages"

// Messages
export type { Message, MessageParam } from "@anthropic-ai/sdk/resources/messages"

// Thinking & cache
export type { CacheControlEphemeral, ThinkingConfigParam } from "@anthropic-ai/sdk/resources/messages"

// Stream events
export type {
  RawContentBlockDelta,
  RawContentBlockStartEvent,
  RawContentBlockStopEvent,
  RawMessageDeltaEvent,
  RawMessageStartEvent,
  RawMessageStopEvent,
} from "@anthropic-ai/sdk/resources/messages"

// Internal-only SDK imports (not re-exported)
import type {
  //
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
  messages: Array<MessageParam>
  system?: string | Array<TextBlockParam>
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: Array<string>
  stream?: boolean
  tools?: Array<Tool>
  tool_choice?: ToolChoice
  thinking?: ThinkingConfigParam
  output_config?: OutputConfig
  metadata?: { user_id?: string }
  /** `null` is an internal sentinel meaning "do not auto-inject context_management on retry". */
  context_management?: Record<string, unknown> | null
}

export interface Tool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  cache_control?: CacheControlEphemeral
  type?: string
  defer_loading?: boolean
  /**
   * Client-side tool-input streaming hint (newer Anthropic feature). Modelled
   * here only to make it EXPLICIT that we know about it and deliberately do NOT
   * forward it: GHC's upstream Anthropic API rejects unknown tool fields with
   * `tools.N.custom.eager_input_streaming: Extra inputs are not permitted`, so it
   * is stripped by `stripToolFields` (built-in default). See
   * `lib/request/strategies/tool-field-rejection-retry.ts` for the general
   * learner that auto-strips any future unknown tool field.
   */
  eager_input_streaming?: boolean
}

export type ToolChoice = { type: "auto" } | { type: "any" } | { type: "none" } | { type: "tool"; name: string }

/**
 * Known effort levels, ordered from lowest to highest.
 *
 * - "none" — reasoning disabled entirely (declared by gpt-5.5; semantically
 *   below "low" so clamping to the lowest supported value gracefully degrades
 *   when the model whitelist excludes it).
 * - "low"/"medium"/"high"/"xhigh"/"max" — increasing reasoning budget.
 */
export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * Structured-outputs format descriptor (`output_config.format`).
 *
 * Carries the JSON-schema the client wants the model's output constrained to
 * (Anthropic structured outputs). Some upstreams disallow this feature — e.g.
 * GHC routing to Vertex AI where the org policy
 * `constraints/vertexai.allowedPartnerModelFeatures` blocks `structured_outputs`
 * for the partner Claude model, returning a 400. The
 * `structured-outputs-rejection-retry` strategy reacts by stripping this field.
 */
export interface OutputFormat {
  type: string
  schema?: Record<string, unknown>
}

export interface OutputConfig {
  effort?: string
  format?: OutputFormat
}

// ============================================================================
// Message subtypes (narrow role for cast convenience)
// ============================================================================

export interface UserMessage {
  role: "user"
  content: string | Array<ContentBlockParam>
}

export interface AssistantMessage {
  role: "assistant"
  content: string | Array<ContentBlockParam>
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
  ip_code_citations?: Array<CopilotIPCodeCitation>
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
export function isToolResultBlock(block: ContentBlockParam): block is ToolResultBlockParam {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- type guard pattern requires cast
  return (block as ToolResultBlockParam).type === "tool_result"
}

/** Type guard for server-side tool result blocks (web_search, tool_search, code_execution, etc.) */
export function isServerToolResultBlock(block: ContentBlockParam | ContentBlock): block is WebSearchToolResultBlock {
  // Cast to string to allow matching beyond the SDK's narrow literal type union.
  // Server tool results include: web_search_tool_result, tool_search_tool_result,
  // code_execution_tool_result, etc. They all end with "_tool_result" and carry a tool_use_id.
  // Exclude plain "tool_result" which is the standard user-side tool result.
  const type = (block as unknown as Record<string, unknown>).type as string | undefined
  if (!type) return false
  return type !== "tool_result" && type.endsWith("_tool_result") && "tool_use_id" in block
}
