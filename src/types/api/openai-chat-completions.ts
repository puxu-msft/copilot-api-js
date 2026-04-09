/**
 * OpenAI API Types
 *
 * Streaming types are imported from the official `openai` SDK package to stay
 * in sync with upstream. Non-streaming and request types remain our own
 * definitions since:
 * - We're a proxy that mutates messages without discriminated union narrowing
 * - The SDK's union tool types (FunctionTool | CustomTool) add unnecessary narrowing
 * - The SDK's ChatCompletion.Choice.message uses SDK-internal ToolCall unions
 */

import type { ChatCompletionChunk as SdkChatCompletionChunk } from "openai/resources/chat/completions"
import type { CompletionUsage } from "openai/resources/completions"

// ============================================================================
// Streaming Types (from SDK — we consume these as-is from upstream)
// ============================================================================

export type ChatCompletionChunk = SdkChatCompletionChunk
export type StreamingChoice = SdkChatCompletionChunk.Choice
export type StreamingDelta = SdkChatCompletionChunk.Choice.Delta
export type ChatCompletionUsage = CompletionUsage

// ============================================================================
// Non-Streaming Response Types (our own)
// ============================================================================

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "function_call"

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<NonStreamingChoice>
  usage?: ChatCompletionUsage
  system_fingerprint?: string
  service_tier?: string | null
}

export interface NonStreamingChoice {
  index: number
  message: ResponseMessage
  finish_reason: FinishReason | null
  logprobs?: object | null
}

export interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
  refusal?: string | null
}

// ============================================================================
// Request Types (our own)
//
// We use a single Message interface rather than the SDK's discriminated union
// (ChatCompletionMessageParam). As a proxy, we mutate messages across
// sanitizers, truncators, and translators without narrowing by role.
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

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
    strict?: boolean
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

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  max_completion_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  top_logprobs?: number | null
  response_format?: ResponseFormat | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } } | null
  parallel_tool_calls?: boolean | null
  user?: string | null
  service_tier?: string | null
  stream_options?: { include_usage?: boolean } | null
}

/** JSON Schema response format for structured outputs */
export interface JsonSchemaResponseFormat {
  type: "json_schema"
  json_schema: {
    name: string
    description?: string
    schema: Record<string, unknown>
    strict?: boolean
  }
}

/** Simple JSON object response format */
export interface JsonObjectResponseFormat {
  type: "json_object"
}

/** Text response format (default) */
export interface TextResponseFormat {
  type: "text"
}

export type ResponseFormat = JsonObjectResponseFormat | JsonSchemaResponseFormat | TextResponseFormat
