/**
 * Google Gemini API request/response types.
 *
 * We import data-only types from `@google/genai`. The SDK ships a class-based
 * `GenerateContentResponse` (with `.text`, `.functionCalls`, etc. getters) —
 * we strip the methods via `Pick<>` so consumers see a plain data shape that
 * round-trips through JSON cleanly. Mirrors agent-maestro's approach in
 * refs/agent-maestro/src/server/schemas/gemini.ts.
 */

import type {
  //
  Content,
  GenerationConfig,
  SafetySetting,
  Tool,
  ToolConfig,
  GenerateContentResponse as _GenerateContentResponse,
} from "@google/genai"

/** Inbound `:generateContent` / `:streamGenerateContent` request body */
export interface GenerateContentRequest {
  contents?: Array<Content>
  tools?: Array<Tool>
  toolConfig?: ToolConfig
  safetySettings?: Array<SafetySetting>
  systemInstruction?: Content
  generationConfig?: GenerationConfig
  cachedContent?: string
}

/**
 * Outbound `:generateContent` / `:streamGenerateContent` response body.
 *
 * `Pick<>` drops the SDK class methods (`text`, `data`, `functionCalls`,
 * `executableCode`, `codeExecutionResult`) so the type represents the wire
 * shape, not the SDK helper accessors.
 */
export type GenerateContentResponse = Pick<_GenerateContentResponse, "candidates" | "promptFeedback" | "usageMetadata" | "modelVersion" | "responseId">

/** Inbound `:countTokens` request body */
export interface CountTokensRequest {
  contents?: Array<Content>
  generateContentRequest?: GenerateContentRequest
  cachedContent?: string
}

/** Outbound `:countTokens` response body */
export interface CountTokensResponse {
  totalTokens: number
  cachedContentTokenCount?: number
}

/** Gemini-style error envelope (gRPC-shaped status field) */
export interface GeminiErrorResponse {
  error: {
    code: number
    message: string
    status: string
  }
}

// Re-export the underlying type aliases so consumers can avoid pulling in the
// SDK directly. Keeps the single source of truth here.
export type { Content, GenerationConfig, Part, SafetySetting, Tool, ToolConfig } from "@google/genai"
