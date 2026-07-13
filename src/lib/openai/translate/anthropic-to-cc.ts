/**
 * Non-streaming response translation: Anthropic Messages response → Chat Completions response.
 *
 * The REVERSE-leg RESPONSE translator of the translation matrix (RFC 2026-07-11-anthropic-via-openai-translation
 * §8.2 / spec §7): a CC / Responses / Gemini client pinned to `@messages` reached a direct-Anthropic
 * upstream leg (request translated by `cc-to-anthropic-request.ts`); the upstream returns an Anthropic
 * Messages response, which this turns back into the CC completion the client's format expects (Responses
 * / Gemini clients get a further second hop CC→their format, handled by their own render — WARN-F).
 *
 * Direction (the mirror of `cc-to-anthropic.ts`, the forward-leg response translator):
 *   upstream Anthropic response ─► translateAnthropicResponseToCC ─► client CC completion
 *
 * Modelled on `responses-to-cc.ts` — same "collect the parts, fold into a single CC choice" discipline.
 * Anthropic content blocks describe ONE assistant turn, so they collapse into ONE CC `choices[0]`
 * message (`content` + `tool_calls` coexist — CC permits it; NO multi-choices split, the inverse of the
 * forward fold).
 *
 * Graceful degradation (spec §7 / §11 reverse column):
 *   - `thinking` / `redacted_thinking` blocks → DROPPED. CC carries no thinking channel; this is a
 *     benign forward-of-response drop (the reverse RED LINE against SYNTHESIZING thinking is a
 *     request-side concern in `cc-to-anthropic-request.ts`, N/A on a genuine model response).
 *   - `server_tool_use` / `*_tool_result` blocks → DROPPED (no CC equivalent).
 *   - `tool_use.input` → `tool_call.function.arguments` via JSON.stringify.
 *   - `stop_reason` → `finish_reason`; `usage` → CC usage.
 */

import type {
  //
  ContentBlock,
  Message as AnthropicResponse,
} from "~/types/api/anthropic"
import type {
  //
  ChatCompletionResponse,
  ChatCompletionUsage,
  FinishReason,
  ResponseMessage,
  ToolCall,
} from "~/types/api/openai-chat-completions"

// ============================================================================
// Top-level response translation (Anthropic → CC)
// ============================================================================

/**
 * Translate an Anthropic Messages response into a Chat Completions response (reverse-leg response).
 *
 * Collapses the Anthropic content blocks into ONE CC `choices[0]` message (content + tool_calls). The
 * upstream endpoint's own render (Responses / Gemini second hop) consumes this CC shape downstream.
 */
export function translateAnthropicResponseToCC(response: AnthropicResponse): ChatCompletionResponse {
  const message = foldContentBlocks(response.content)

  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReason(response.stop_reason, message.tool_calls !== undefined),
        logprobs: null,
      },
    ],
    ...(response.usage && { usage: mapUsage(response.usage) }),
  }
}

// ============================================================================
// Content blocks → CC message
// ============================================================================

/**
 * Fold Anthropic content blocks into ONE CC assistant message. Text blocks concatenate into `content`;
 * tool_use blocks become `tool_calls`. thinking / redacted_thinking / server-tool blocks are dropped.
 * `content` is null when the turn is tool-only (CC convention).
 */
function foldContentBlocks(blocks: Array<ContentBlock>): ResponseMessage {
  const textParts: Array<string> = []
  const toolCalls: Array<ToolCall> = []

  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        textParts.push(block.text)
        break
      }
      case "tool_use": {
        toolCalls.push(toolUseToToolCall(block))
        break
      }
      case "thinking":
      case "redacted_thinking": {
        // CC has no thinking channel — drop (a genuine response drop, NOT synthesis; see module docstring).
        break
      }
      default: {
        // server_tool_use / *_tool_result / any future server-side artifact — no CC equivalent, drop.
        break
      }
    }
  }

  const text = textParts.join("")
  return {
    role: "assistant",
    content: text.length > 0 ? text : null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  }
}

/** Anthropic `tool_use` block → CC `tool_calls[]` entry (id passed through; arguments = JSON.stringify(input)). */
function toolUseToToolCall(block: Extract<ContentBlock, { type: "tool_use" }>): ToolCall {
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input ?? {}),
    },
  }
}

// ============================================================================
// stop_reason → finish_reason / usage
// ============================================================================

/**
 * The minimal Anthropic usage fields {@link mapUsage} reads. The non-streaming response's
 * `Message["usage"]` structurally satisfies it; the stream accumulator supplies the same four fields
 * assembled from `message_start` (input + cache legs) + `message_delta` (final output).
 */
export interface AnthropicUsageLike {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/**
 * Anthropic `stop_reason` → CC `finish_reason`. `tool_use`→tool_calls, `max_tokens`→length,
 * `refusal`→content_filter; `end_turn`/`stop_sequence`/`pause_turn`/null → stop. A present tool_calls
 * array forces `tool_calls` even if the upstream stop_reason lagged (defensive — mirrors CC semantics).
 *
 * Exported (not file-local) so the reverse STREAMING translator (`anthropic-to-cc-stream.ts`) reuses
 * the SAME mapping — one source of truth (fix-all-comparison-sites), never a copy-paste.
 */
export function mapStopReason(stopReason: AnthropicResponse["stop_reason"], hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return "tool_calls"
  switch (stopReason) {
    case "tool_use": {
      return "tool_calls"
    }
    case "max_tokens": {
      return "length"
    }
    case "refusal": {
      return "content_filter"
    }
    default: {
      // end_turn / stop_sequence / pause_turn / null → stop.
      return "stop"
    }
  }
}

/**
 * Anthropic `usage` → CC `usage`. `input_tokens`→`prompt_tokens`, `output_tokens`→`completion_tokens`,
 * total = sum; best-effort forwards BOTH cache legs symmetrically with the forward translator
 * (`cache_read_input_tokens`→`prompt_tokens_details.cached_tokens`, `cache_creation_input_tokens`→
 * `prompt_tokens_details.cache_write_tokens` — the GHC extension the forward leg reads back, richest-data-flow).
 *
 * Exported (not file-local) so the reverse STREAMING translator (`anthropic-to-cc-stream.ts`) reuses
 * the SAME gross-up — one source of truth (fix-all-comparison-sites), never a copy-paste of the net→total
 * arithmetic (W-rev under-count risk). Accepts the minimal usage shape both the non-streaming response and
 * the stream accumulator can supply.
 */
export function mapUsage(usage: AnthropicUsageLike): ChatCompletionUsage {
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  const cacheRead = usage.cache_read_input_tokens
  const cacheCreation = usage.cache_creation_input_tokens
  const promptDetails =
    cacheRead != null || cacheCreation != null ?
      {
        ...(cacheRead != null && { cached_tokens: cacheRead }),
        ...(cacheCreation != null && { cache_write_tokens: cacheCreation }),
      }
    : undefined
  // Anthropic `input_tokens` is the NET uncached input (disjoint from the cache legs); CC
  // `prompt_tokens` is the TOTAL prompt INCLUDING cached tokens (usage-normalize.ts oracle).
  // Rebuild the CC total by adding the cache legs back, else a downstream `usageFromTotalInput`
  // would subtract cached a second time and UNDER-count (W-rev, mirror of B1's over-count).
  const promptTokens = inputTokens + (cacheRead ?? 0) + (cacheCreation ?? 0)
  return {
    prompt_tokens: promptTokens,
    completion_tokens: outputTokens,
    total_tokens: promptTokens + outputTokens,
    ...(promptDetails && { prompt_tokens_details: promptDetails }),
  }
}
