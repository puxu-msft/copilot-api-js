import consola from "consola"

import type { Model } from "~/lib/models/client"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"
import type {
  //
  ResponsesInputItem,
  ResponsesPayload,
} from "~/types/api/openai-responses"

import { copilotHeaders } from "~/lib/copilot-api"
import { state } from "~/lib/state"
import { isNullish } from "~/lib/utils"

export interface PreparedOpenAIRequest<TPayload> {
  wire: TPayload
  headers: Record<string, string>
}

interface PrepareOpenAIRequestOptions {
  resolvedModel?: Model
}

/**
 * O10 — auto-fill `max_completion_tokens` when the client sent NEITHER
 * `max_tokens` nor `max_completion_tokens`, using the model's declared max output
 * limit. Returns the payload unchanged when either token field is already
 * present. Extracted from the inline CC handler step (P1.4) so this rewrite is
 * named and testable; the other OpenAI request rewrites are already named
 * functions applied point-wise in the handlers (see docs/v4/05-progress.md for
 * why the OpenAI side is not forced into a single-chain registry like Anthropic).
 */
export function fillMaxCompletionTokens(payload: ChatCompletionsPayload, selectedModel: Model | undefined): ChatCompletionsPayload {
  const hasMaxTokens = !isNullish(payload.max_tokens) || !isNullish(payload.max_completion_tokens)
  if (hasMaxTokens) return payload
  const filled = { ...payload, max_completion_tokens: selectedModel?.capabilities?.limits?.max_output_tokens }
  consola.debug("Set max_completion_tokens to:", JSON.stringify(filled.max_completion_tokens))
  return filled
}

/**
 * OpenAI's `user` field wire limit — the Responses / Chat-Completions endpoints reject any `user`
 * string longer than 64 chars (`HTTP 400 invalid_request_body: Invalid 'user': string too long`).
 */
const OPENAI_USER_MAX_LENGTH = 64

/**
 * Fit the OpenAI `user` field within the upstream's 64-char wire limit.
 *
 * Claude Code sends a ~150-char JSON blob as `metadata.user_id`
 * (`{"device_id":…,"account_uuid":…,"session_id":…}`) which the anthropic→cc translation maps onto
 * `user`; the OpenAI-family endpoints then 400 on it. In this single-user proxy the `device_id` /
 * `account_uuid` are constant, so the only discriminating (and semantically apt) part is the
 * `session_id` — extract it so upstream gets a stable per-session identifier. Non-JSON over-length
 * values fall back to truncation.
 *
 * The clamp lives at this OpenAI-family wire boundary rather than at the source mapping — the
 * Anthropic `/v1/messages` leg has no such limit and does not funnel through here (richest-data-flow:
 * trim only at the terminal that constrains the value; history keeps the full original user_id).
 */
function fitUserField<T extends { user?: string | null }>(payload: T): T {
  const { user } = payload
  if (typeof user !== "string" || user.length <= OPENAI_USER_MAX_LENGTH) return payload
  const fitted = (extractSessionId(user) ?? user).slice(0, OPENAI_USER_MAX_LENGTH)
  return { ...payload, user: fitted }
}

/** Pull a non-empty `session_id` out of Claude Code's JSON `user_id` blob; undefined if absent / not JSON. */
function extractSessionId(user: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(user)
    if (parsed !== null && typeof parsed === "object" && "session_id" in parsed) {
      const sid = (parsed as { session_id: unknown }).session_id
      if (typeof sid === "string" && sid.length > 0) return sid
    }
  } catch {
    // Not JSON — fall through to truncation.
  }
  return undefined
}

export function prepareChatCompletionsRequest(
  payload: ChatCompletionsPayload,
  opts?: PrepareOpenAIRequestOptions,
): PreparedOpenAIRequest<ChatCompletionsPayload> {
  const wire = fitUserField(shouldRemapMaxTokens(opts?.resolvedModel, payload.model) ? normalizeMaxTokens(payload) : payload)

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
  const wire = fitUserField(payload)
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
