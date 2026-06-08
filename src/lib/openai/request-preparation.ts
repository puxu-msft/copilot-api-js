import type { Model } from "~/lib/models/client"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"
import type {
  //
  ResponsesInputItem,
  ResponsesPayload,
} from "~/types/api/openai-responses"

import { copilotHeaders } from "~/lib/copilot-api"
import { state } from "~/lib/state"

export interface PreparedOpenAIRequest<TPayload> {
  wire: TPayload
  headers: Record<string, string>
}

interface PrepareOpenAIRequestOptions {
  resolvedModel?: Model
}

export function prepareChatCompletionsRequest(
  payload: ChatCompletionsPayload,
  opts?: PrepareOpenAIRequestOptions,
): PreparedOpenAIRequest<ChatCompletionsPayload> {
  const wire = shouldRemapMaxTokens(opts?.resolvedModel, payload.model) ? normalizeMaxTokens(payload) : payload

  const enableVision = wire.messages.some((message) => typeof message.content !== "string" && message.content?.some((part) => part.type === "image_url"))

  const isAgentCall = wire.messages.some((message) => ["assistant", "tool"].includes(message.role))
  const modelSupportsVision = opts?.resolvedModel?.capabilities?.supports?.vision !== false

  const headers: Record<string, string> = {
    ...copilotHeaders(state, {
      vision: enableVision && modelSupportsVision,
      modelRequestHeaders: opts?.resolvedModel?.request_headers,
      intent: isAgentCall ? "conversation-agent" : "conversation-panel",
    }),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  return { wire, headers }
}

export function prepareResponsesRequest(payload: ResponsesPayload, opts?: PrepareOpenAIRequestOptions): PreparedOpenAIRequest<ResponsesPayload> {
  const wire = payload
  const enableVision = hasVisionContent(wire.input)
  const isAgentCall =
    Array.isArray(wire.input) && wire.input.some((item) => item.role === "assistant" || item.type === "function_call" || item.type === "function_call_output")
  const modelSupportsVision = opts?.resolvedModel?.capabilities?.supports?.vision !== false

  const headers: Record<string, string> = {
    ...copilotHeaders(state, {
      vision: enableVision && modelSupportsVision,
      modelRequestHeaders: opts?.resolvedModel?.request_headers,
      intent: isAgentCall ? "conversation-agent" : "conversation-panel",
    }),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  return { wire, headers }
}

function hasVisionContent(input: string | Array<ResponsesInputItem>): boolean {
  if (typeof input === "string") return false
  return input.some((item) => Array.isArray(item.content) && item.content.some((part) => "type" in part && part.type === "input_image"))
}

/**
 * Normalize max_tokens → max_completion_tokens for upstream wire payload.
 *
 * OpenAI deprecated `max_tokens` in favor of `max_completion_tokens`. Newer
 * models (gpt-5.x, o-series) reject `max_tokens` entirely. Callers must gate
 * this via shouldRemapMaxTokens() so non-OpenAI upstreams are unaffected.
 */
function normalizeMaxTokens(payload: ChatCompletionsPayload): ChatCompletionsPayload {
  if (
    (payload.max_tokens === undefined || payload.max_tokens === null)
    && (payload.max_completion_tokens === undefined || payload.max_completion_tokens === null)
  ) {
    return payload
  }

  const { max_tokens, ...rest } = payload
  return {
    ...rest,
    // Client's explicit max_completion_tokens takes precedence over max_tokens
    max_completion_tokens: payload.max_completion_tokens ?? max_tokens,
  }
}

/**
 * Gate the max_tokens → max_completion_tokens remap to OpenAI-flavored models only.
 *
 * Non-OpenAI vendors (Anthropic, Google, etc.) still accept max_tokens on their
 * OpenAI-compat endpoints, and remapping there would silently drop the field on
 * upstreams that don't recognize max_completion_tokens. When the model isn't in
 * the index (unknown gpt-* names that fall back to chat completions), the gpt-*
 * heuristic catches them.
 */
function shouldRemapMaxTokens(resolved: Model | undefined, modelName: string): boolean {
  const vendor = resolved?.vendor
  if (vendor === "OpenAI" || vendor === "Azure OpenAI") return true
  if (!resolved && /^gpt-/i.test(modelName)) return true
  return false
}
