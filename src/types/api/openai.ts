/**
 * OpenAI API Types
 * Centralized type definitions for OpenAI/Copilot message format.
 */

// ============================================================================
// Streaming Types
// ============================================================================

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<StreamingChoice>
  system_fingerprint?: string
  usage?: ChatCompletionUsage
}

export interface ChatCompletionUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens: number
  }
  completion_tokens_details?: {
    accepted_prediction_tokens: number
    rejected_prediction_tokens: number
  }
}

export interface StreamingDelta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

export interface StreamingChoice {
  index: number
  delta: StreamingDelta
  finish_reason: FinishReason | null
  logprobs: object | null
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter"

// ============================================================================
// Non-Streaming Types
// ============================================================================

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<NonStreamingChoice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

export interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

export interface NonStreamingChoice {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: FinishReason
}

// ============================================================================
// Payload Types
// ============================================================================

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
}

// ============================================================================
// Tool Types
// ============================================================================

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

// ============================================================================
// Message Types
// ============================================================================

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
