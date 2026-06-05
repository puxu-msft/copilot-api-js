/**
 * OpenAI Chat Completions → Gemini `GenerateContentResponse` conversion.
 *
 * Usage extraction follows agent-maestro/src/server/utils/gemini.ts
 * (extractGeminiUsage): `promptTokenCount` is computed as
 * `prompt_tokens − cached_tokens` so the cached portion is exposed
 * separately via `cachedContentTokenCount`, matching Gemini API semantics
 * where `promptTokenCount` excludes cached content.
 */

import type {
  //
  GenerateContentResponse,
  Part,
} from "~/types/api/gemini"
import type {
  //
  ChatCompletionResponse,
  ChatCompletionUsage,
  FinishReason as OpenAIFinishReason,
  ResponseMessage,
} from "~/types/api/openai-chat-completions"

import { safeParseArgs } from "./internal"

/**
 * Token usage metadata in Gemini's shape. We use the SDK enum members as
 * plain string literals so the wire shape is JSON-safe.
 */
export interface GeminiUsageMetadata {
  promptTokenCount: number
  candidatesTokenCount: number
  totalTokenCount: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
}

/** Convert a non-streaming OpenAI ChatCompletionResponse to Gemini shape */
export function convertOpenAIResponseToGemini(
  response: ChatCompletionResponse,
  modelId: string,
): GenerateContentResponse & { usageMetadata: GeminiUsageMetadata } {
  const choice = response.choices[0]
  const parts = messageToParts(choice.message)
  const finishReason = openAIFinishToGemini(choice.finish_reason)
  const usageMetadata = extractUsageMetadata(response.usage)

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason,
        index: 0,
      },
    ],
    usageMetadata,
    modelVersion: modelId,
    responseId: response.id,
  } as GenerateContentResponse & { usageMetadata: GeminiUsageMetadata }
}

/** Convert an OpenAI assistant message to a Gemini Part array */
export function messageToParts(message: ResponseMessage | undefined): Array<Part> {
  if (!message) return []
  const parts: Array<Part> = []
  if (message.content) {
    parts.push({ text: message.content })
  }
  for (const tc of message.tool_calls ?? []) {
    parts.push({
      functionCall: {
        id: tc.id,
        name: tc.function.name,
        args: safeParseArgs(tc.function.arguments),
      },
    })
  }
  return parts
}

/**
 * Map OpenAI `finish_reason` to Gemini `FinishReason`. Returns the wire
 * string directly to keep the response JSON-clean (the SDK enum has the
 * same string values).
 */
export function openAIFinishToGemini(reason: OpenAIFinishReason | null | undefined): string {
  if (!reason) return "FINISH_REASON_UNSPECIFIED"
  if (reason === "stop") return "STOP"
  if (reason === "length") return "MAX_TOKENS"
  if (reason === "content_filter") return "SAFETY"
  // tool_calls / function_call → STOP (Gemini does not have a tool-call-specific finish reason)
  return "STOP"
}

/** Extract Gemini-shaped usage from an OpenAI usage object */
export function extractUsageMetadata(usage: ChatCompletionUsage | undefined): GeminiUsageMetadata {
  if (!usage) {
    return { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
  }
  const cachedTokens = nonNegFinite(usage.prompt_tokens_details?.cached_tokens) ?? 0
  const reasoningTokens = nonNegFinite(usage.completion_tokens_details?.reasoning_tokens) ?? 0
  const promptTokens = nonNegFinite(usage.prompt_tokens) ?? 0
  const completionTokens = nonNegFinite(usage.completion_tokens) ?? 0
  const totalTokens = nonNegFinite(usage.total_tokens) ?? promptTokens + completionTokens + reasoningTokens

  const promptTokenCount = Math.max(0, promptTokens - cachedTokens)

  const out: GeminiUsageMetadata = {
    promptTokenCount,
    candidatesTokenCount: completionTokens,
    totalTokenCount: totalTokens,
  }
  if (cachedTokens > 0) out.cachedContentTokenCount = cachedTokens
  if (reasoningTokens > 0) out.thoughtsTokenCount = reasoningTokens
  return out
}

function nonNegFinite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}
