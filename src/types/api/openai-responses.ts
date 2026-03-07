/**
 * OpenAI Responses API Types
 *
 * Types for the /responses endpoint, which uses a different format
 * from /chat/completions. Key differences:
 * - Semantic event-based streaming (vs chunked delta streaming)
 * - `input` instead of `messages`, `instructions` instead of system messages
 * - `previous_response_id` for server-managed conversation state
 * - Independent `function_call` output items (vs tool_calls inside message)
 */

// ============================================================================
// Request Types
// ============================================================================

/** Input content part for message-type input items */
export type ResponsesInputContentPart = ResponsesInputTextPart | ResponsesInputImagePart | ResponsesInputFilePart

export interface ResponsesInputTextPart {
  type: "input_text"
  text: string
}

export interface ResponsesInputImagePart {
  type: "input_image"
  image_url: string
  detail?: "low" | "high" | "auto"
}

export interface ResponsesInputFilePart {
  type: "input_file"
  file_id?: string
  filename?: string
  file_data?: string
}

/** Output text content part (used in assistant messages within input history) */
export interface ResponsesOutputTextPart {
  type: "output_text"
  text: string
}

/**
 * A single item in the `input` array.
 * Can be a message, a function call record, or a function call output.
 */
export interface ResponsesInputItem {
  type?: "message" | "function_call" | "function_call_output" | "item_reference" | "reasoning" | (string & {})
  /** Role for message-type items */
  role?: "user" | "assistant" | "system" | "developer"
  /** Content for message-type items */
  content?: string | Array<ResponsesInputContentPart | ResponsesOutputTextPart>
  /** Unique ID for this item (function_call type) */
  id?: string
  /** Call ID linking function_call to its output */
  call_id?: string
  /** Function name (function_call type) */
  name?: string
  /** Serialized function arguments (function_call type) */
  arguments?: string
  /** Function output string (function_call_output type) */
  output?: string
  /** Status of the item */
  status?: string
  /** Summary parts for reasoning items */
  summary?: Array<{ type: string; text: string }>
  /** Encrypted content for reasoning/compaction items (used for round-tripping thinking data) */
  encrypted_content?: string
}

/** Tool definition for the Responses API */
export type ResponsesTool = ResponsesFunctionTool | ResponsesBuiltinTool

export interface ResponsesFunctionTool {
  type: "function"
  name: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

export interface ResponsesBuiltinTool {
  type: "web_search" | "file_search" | "code_interpreter"
  [key: string]: unknown
}

/** Text output format configuration */
export type ResponsesTextFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema"
      name: string
      description?: string
      schema: Record<string, unknown>
      strict?: boolean
    }

/** Reasoning/thinking configuration */
export interface ResponsesReasoning {
  effort?: "low" | "medium" | "high"
  summary?: "auto" | "concise" | "detailed"
}

/** Tool choice for Responses API */
export type ResponsesToolChoice = "auto" | "none" | "required" | { type: "function"; name: string }

/** Context management configuration (e.g. compaction) */
export interface ResponsesContextManagement {
  type: string
  compact_threshold?: number
}

/** Request payload for POST /responses */
export interface ResponsesPayload {
  model: string
  input: string | Array<ResponsesInputItem>
  instructions?: string | null
  stream?: boolean | null
  previous_response_id?: string | null
  max_output_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  tools?: Array<ResponsesTool>
  tool_choice?: ResponsesToolChoice
  parallel_tool_calls?: boolean
  reasoning?: ResponsesReasoning | null
  metadata?: Record<string, string> | null
  store?: boolean
  truncation?: "auto" | "disabled" | null
  text?: { format?: ResponsesTextFormat; verbosity?: string }
  include?: Array<string>
  service_tier?: string | null
  user?: string | null
  /** Context management configuration (e.g. compaction) */
  context_management?: Array<ResponsesContextManagement>
  /** Number of top log probabilities to return per token */
  top_logprobs?: number | null
}

// ============================================================================
// Response Types (Non-Streaming)
// ============================================================================

/** Text content in an output message */
export interface ResponsesOutputTextContent {
  type: "output_text"
  text: string
  annotations: Array<unknown>
}

/** Refusal content in an output message */
export interface ResponsesOutputRefusalContent {
  type: "refusal"
  refusal: string
}

/** A message output item */
export interface ResponsesMessageOutput {
  type: "message"
  id: string
  role: "assistant"
  status: "completed" | "incomplete"
  content: Array<ResponsesOutputTextContent | ResponsesOutputRefusalContent>
}

/** A function call output item */
export interface ResponsesFunctionCallOutput {
  type: "function_call"
  id: string
  call_id: string
  name: string
  arguments: string
  status: "completed" | "incomplete"
}

/** A reasoning output item (contains thinking summary and encrypted content for round-tripping) */
export interface ResponsesReasoningOutput {
  type: "reasoning"
  id: string
  summary: Array<{ type: "summary_text"; text: string }>
  encrypted_content?: string
  status?: string
}

/** Union of all output item types */
export type ResponsesOutputItem = ResponsesMessageOutput | ResponsesFunctionCallOutput | ResponsesReasoningOutput

/** Usage statistics */
export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  output_tokens_details?: {
    reasoning_tokens: number
  }
  input_tokens_details?: {
    cached_tokens: number
  }
}

/** Full response object from POST /responses */
export interface ResponsesResponse {
  id: string
  object: "response"
  created_at: number
  status: "completed" | "failed" | "in_progress" | "incomplete" | "cancelled"
  model: string
  output: Array<ResponsesOutputItem>
  usage: ResponsesUsage | null
  /** Echoed back from request */
  instructions?: string | null
  max_output_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  tools: Array<ResponsesTool>
  tool_choice: ResponsesToolChoice
  parallel_tool_calls: boolean
  previous_response_id?: string | null
  reasoning?: ResponsesReasoning | null
  metadata?: Record<string, string> | null
  truncation?: string | null
  error?: ResponsesError | null
  incomplete_details?: { reason: string } | null
  text?: { format?: ResponsesTextFormat; verbosity?: string }
  store: boolean
  service_tier?: string | null
}

/** Error detail within a response */
export interface ResponsesError {
  message: string
  type: string
  code: string
}

// ============================================================================
// SSE Streaming Event Types
//
// Responses API uses semantic events instead of chunked deltas.
// Each event has a `type` field and a monotonically increasing `sequence_number`.
// ============================================================================

/** Response lifecycle events */
export interface ResponseCreatedEvent {
  type: "response.created"
  response: ResponsesResponse
  sequence_number: number
}

export interface ResponseInProgressEvent {
  type: "response.in_progress"
  response: ResponsesResponse
  sequence_number: number
}

export interface ResponseCompletedEvent {
  type: "response.completed"
  response: ResponsesResponse
  sequence_number: number
}

export interface ResponseFailedEvent {
  type: "response.failed"
  response: ResponsesResponse
  sequence_number: number
}

export interface ResponseIncompleteEvent {
  type: "response.incomplete"
  response: ResponsesResponse
  sequence_number: number
}

/** Output item lifecycle events */
export interface OutputItemAddedEvent {
  type: "response.output_item.added"
  output_index: number
  item: ResponsesOutputItem
  sequence_number: number
}

export interface OutputItemDoneEvent {
  type: "response.output_item.done"
  output_index: number
  item: ResponsesOutputItem
  sequence_number: number
}

/** Content part lifecycle events */
export interface ContentPartAddedEvent {
  type: "response.content_part.added"
  output_index: number
  content_index: number
  part: ResponsesOutputTextContent | ResponsesOutputRefusalContent
  sequence_number: number
}

export interface ContentPartDoneEvent {
  type: "response.content_part.done"
  output_index: number
  content_index: number
  part: ResponsesOutputTextContent | ResponsesOutputRefusalContent
  sequence_number: number
}

/** Text delta events */
export interface OutputTextDeltaEvent {
  type: "response.output_text.delta"
  output_index: number
  content_index: number
  delta: string
  sequence_number: number
}

export interface OutputTextDoneEvent {
  type: "response.output_text.done"
  output_index: number
  content_index: number
  text: string
  sequence_number: number
}

/** Function call argument events */
export interface FunctionCallArgumentsDeltaEvent {
  type: "response.function_call_arguments.delta"
  output_index: number
  item_id: string
  delta: string
  sequence_number: number
}

export interface FunctionCallArgumentsDoneEvent {
  type: "response.function_call_arguments.done"
  output_index: number
  item_id: string
  arguments: string
  sequence_number: number
}

/** Refusal delta events */
export interface RefusalDeltaEvent {
  type: "response.refusal.delta"
  output_index: number
  content_index: number
  delta: string
  sequence_number: number
}

export interface RefusalDoneEvent {
  type: "response.refusal.done"
  output_index: number
  content_index: number
  refusal: string
  sequence_number: number
}

/** Reasoning summary events (for thinking/reasoning round-trips) */
export interface ReasoningSummaryPartAddedEvent {
  type: "response.reasoning_summary_part.added"
  item_id: string
  output_index: number
  summary_index: number
  part: { type: "summary_text"; text: string }
  sequence_number: number
}

export interface ReasoningSummaryTextDeltaEvent {
  type: "response.reasoning_summary_text.delta"
  item_id: string
  output_index: number
  summary_index: number
  delta: string
  sequence_number: number
}

export interface ReasoningSummaryTextDoneEvent {
  type: "response.reasoning_summary_text.done"
  item_id: string
  output_index: number
  summary_index: number
  text: string
  sequence_number: number
}

export interface ReasoningSummaryPartDoneEvent {
  type: "response.reasoning_summary_part.done"
  item_id: string
  output_index: number
  summary_index: number
  part: { type: "summary_text"; text: string }
  sequence_number: number
}

/** Error event */
export interface ResponsesStreamErrorEvent {
  type: "error"
  message: string
  code: string
  sequence_number: number
}

/** Union of all possible streaming events */
export type ResponsesStreamEvent =
  // Response lifecycle
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | ResponseIncompleteEvent
  // Output item lifecycle
  | OutputItemAddedEvent
  | OutputItemDoneEvent
  // Content part lifecycle
  | ContentPartAddedEvent
  | ContentPartDoneEvent
  // Text streaming
  | OutputTextDeltaEvent
  | OutputTextDoneEvent
  // Function call streaming
  | FunctionCallArgumentsDeltaEvent
  | FunctionCallArgumentsDoneEvent
  // Refusal streaming
  | RefusalDeltaEvent
  | RefusalDoneEvent
  // Reasoning summary streaming
  | ReasoningSummaryPartAddedEvent
  | ReasoningSummaryTextDeltaEvent
  | ReasoningSummaryTextDoneEvent
  | ReasoningSummaryPartDoneEvent
  // Error
  | ResponsesStreamErrorEvent
