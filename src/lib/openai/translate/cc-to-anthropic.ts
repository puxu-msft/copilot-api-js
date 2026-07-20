/**
 * Non-streaming response translation: Chat Completions response → Anthropic Messages response.
 *
 * The FORWARD-leg RESPONSE translator of the translation matrix (RFC 2026-07-11-anthropic-via-openai-translation
 * §7.1 / spec §7.1): an Anthropic `/v1/messages` client pinned to `@cc`/`@responses` reached the
 * upstream through the OpenAI protocol leg (request translated by `anthropic-to-cc-request.ts`); the
 * upstream returns a CC-shaped completion, which this turns back into the Anthropic Messages response
 * the client expects.
 *
 * Direction (the mirror of `anthropic-to-cc.ts`, the reverse-leg response translator):
 *   upstream CC completion ─► translateCCResponseToAnthropic ─► client Anthropic Messages response
 *
 * Modelled on `responses-to-cc.ts` (the Responses→CC non-streaming translator) — same "collect
 * the output parts, fold into the target shape" discipline, in the opposite direction.
 *
 * ⚠️ Multi-choices FOLD (N1 contract / PROBE-FINDINGS): GHC's cc leg splits ONE logical assistant
 * turn's text + tool_use into SEPARATE response `choices` (choices[0] = content text, choices[1] =
 * tool_calls). The response side MUST fold ALL choices back into ONE Anthropic message's `content[]`
 * (text block(s) then tool_use blocks, block order preserved) — reading only `choices[0]` would DROP
 * the tool_calls. This walks every choice in order.
 *
 * Graceful degradation (spec §7.1 / §11):
 *   - `tool_call.function.arguments` → `tool_use.input` via JSON.parse; a malformed string runs the
 *     shared `repairToolInput` cascade (battle-tested tool-input-repair), falling back to `{}` so the
 *     block is always well-formed (never throws, never a bare string input).
 *   - `finish_reason` → `stop_reason`: stop→end_turn / tool_calls→tool_use / length→max_tokens /
 *     content_filter→end_turn (N3: content-filter is DISTINGUISHABLE — the codec records a ctx marker;
 *     Anthropic has no content_filter stop_reason so the wire value degrades to end_turn).
 *   - `message.reasoning`/`reasoning_content` — FORWARDED as a leading synthetic `thinking` block under a
 *     SENTINEL signature (richest-data-flow; stripped on echo-back, see `~/lib/anthropic/synthetic-reasoning`).
 *     GHC's non-streaming cc leg usually returns none (PROBE OQ1), so this is typically a no-op — but when
 *     present it is no longer dropped. We cannot forge a real signature, hence the sentinel + request-side strip.
 */

import type { StopReason } from "@anthropic-ai/sdk/resources/messages"

import type {
  //
  TextBlockParam,
  ThinkingBlockParam,
  ToolUseBlockParam,
} from "~/types/api/anthropic"
import type {
  //
  ChatCompletionResponse,
  ChatCompletionUsage,
  ToolCall,
} from "~/types/api/openai-chat-completions"

import { repairToolInput } from "~/lib/anthropic/tool-input-repair"
import { buildSyntheticReasoningSignature } from "~/lib/anthropic/synthetic-reasoning"
import { netInputTokens } from "~/lib/request/usage-normalize"

/** The default repair cascade for a malformed tool-call `arguments` JSON string (full battle-tested stack). */
const RESPONSE_TOOL_REPAIR_ITEMS = ["tags", "unicode", "jsonrepair"] as const

/** A translated Anthropic response content block (thinking / text / tool_use — the shapes a CC completion yields). */
type AnthropicResponseBlock = ThinkingBlockParam | TextBlockParam | ToolUseBlockParam

/**
 * The Anthropic Messages response shape produced from a CC completion (spec §7.1). A structural subset
 * of the SDK `Message` — the strict SDK response types (`ToolUseBlock.caller`, `TextBlock.citations`,
 * `container`/`stop_details`, `Usage`'s many null fields) are wire-optional, so the codec casts this
 * to `AnthropicMessageResponse` at the boundary. Carries
 * the well-formed essentials the client (Claude Code / Anthropic SDK) reads.
 */
export interface TranslatedAnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  model: string
  content: Array<AnthropicResponseBlock>
  stop_reason: StopReason
  stop_sequence: string | null
  usage: TranslatedAnthropicUsage
}

/** Anthropic usage projected from CC usage (input/output + best-effort cache tokens — richest-data-flow). */
export interface TranslatedAnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** The distinguishable degradations the codec surfaces as ctx markers (N3). Returned alongside the response. */
export interface CcToAnthropicResult {
  response: TranslatedAnthropicResponse
  /** TRUE when any choice finished with `content_filter` — mapped to `end_turn` on the wire but flagged (N3). */
  contentFiltered: boolean
}

// ============================================================================
// Top-level response translation (CC → Anthropic)
// ============================================================================

/**
 * Translate a Chat Completions response into an Anthropic Messages response (forward-leg response).
 *
 * Folds EVERY choice's text + tool_use into ONE Anthropic message `content[]` (N1 multi-choices fold).
 * Returns the response plus the `contentFiltered` observability flag (N3) — the pure translation stays
 * free of ctx side effects; the codec records the marker.
 */
export function translateCCResponseToAnthropic(response: ChatCompletionResponse): CcToAnthropicResult {
  const content: Array<AnthropicResponseBlock> = []
  let sawToolUse = false
  let sawLength = false
  let contentFiltered = false
  // Collect plaintext reasoning across choices — forwarded as a leading synthetic thinking block
  // (richest-data-flow; stripped on echo-back via the labeled-envelope signature). GHC's non-streaming
  // cc leg usually returns none (PROBE OQ1), so this is typically a no-op — but never drop it when present.
  let reasoningText = ""
  let reasoningEncrypted: string | undefined

  // Multi-choices FOLD: walk EVERY choice in order (GHC splits text/tool across choices) and append
  // its text block (if any) then its tool_use blocks — preserving block order across the fold.
  for (const choice of response.choices) {
    const message = choice.message
    const msgExt = message as { reasoning?: unknown; reasoning_content?: unknown; reasoning_encrypted_content?: unknown }
    const reasoningRaw = msgExt.reasoning ?? msgExt.reasoning_content
    if (typeof reasoningRaw === "string") reasoningText += reasoningRaw
    if (typeof msgExt.reasoning_encrypted_content === "string" && msgExt.reasoning_encrypted_content.length > 0) reasoningEncrypted = msgExt.reasoning_encrypted_content
    if (typeof message.content === "string" && message.content.length > 0) {
      content.push({ type: "text", text: message.content } satisfies TextBlockParam)
    }
    // A structured-output refusal (`message.refusal`, OpenAI native field) carries the refusal
    // text — forward it as a text block rather than swallow it (richest-data-flow / never-swallow;
    // mirrors responses-to-cc.ts pushing `part.refusal`). GHC's cc leg may or may not populate it;
    // when absent this is a no-op.
    if (typeof message.refusal === "string" && message.refusal.length > 0) {
      content.push({ type: "text", text: message.refusal } satisfies TextBlockParam)
    }
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        content.push(toolCallToUseBlock(call))
        sawToolUse = true
      }
    }
    // Aggregate the finish reasons across the split choices for the single stop_reason.
    if (choice.finish_reason === "length") sawLength = true
    if (choice.finish_reason === "content_filter") contentFiltered = true
  }

  // Real Anthropic responses ALWAYS carry ≥1 content block (output_tokens is non-zero even for an
  // empty string — SDK docs). An empty upstream completion (all choices empty + no tool_calls, e.g. a
  // content_filter that blocked everything) would otherwise yield `content:[]`, which a client
  // assuming ≥1 block may choke on — degrade to a single empty text block to stay wire-faithful.
  if (content.length === 0) content.push({ type: "text", text: "" } satisfies TextBlockParam)

  // Prepend the synthetic reasoning (thinking) block, if any — Anthropic requires thinking FIRST.
  if (reasoningText.length > 0) {
    content.unshift({ type: "thinking", thinking: reasoningText, signature: buildSyntheticReasoningSignature(reasoningEncrypted) } satisfies ThinkingBlockParam)
  }

  return {
    response: {
      id: response.id,
      type: "message",
      role: "assistant",
      model: response.model,
      content,
      stop_reason: aggregateStopReason(sawToolUse, sawLength),
      stop_sequence: null,
      usage: mapUsage(response.usage),
    },
    contentFiltered,
  }
}

// ============================================================================
// Content blocks
// ============================================================================

/** CC `tool_calls[]` entry → Anthropic `tool_use` block (id passed through verbatim — toolu_* survives). */
function toolCallToUseBlock(call: ToolCall): ToolUseBlockParam {
  return {
    type: "tool_use",
    id: call.id,
    name: call.function.name,
    input: parseToolArguments(call.function.arguments),
  }
}

/**
 * Parse a CC tool-call `arguments` JSON string → Anthropic `input` object. A malformed string runs the
 * shared battle-tested repair cascade (tag-strip → unicode-fix → jsonrepair); an unrepairable result
 * degrades to `{}` (always a well-formed object input — never throws, never a bare non-object).
 */
function parseToolArguments(args: string): unknown {
  if (!args) return {}
  try {
    return JSON.parse(args)
  } catch {
    const repaired = repairToolInput(args, RESPONSE_TOOL_REPAIR_ITEMS)
    return "repaired" in repaired ? repaired.repaired : {}
  }
}

// ============================================================================
// finish_reason → stop_reason / usage
// ============================================================================

/**
 * Aggregate the split choices' finish reasons into ONE Anthropic `stop_reason`. Tool use wins (the
 * turn invoked tools); else a length cutoff → max_tokens; else end_turn (covers stop / content_filter
 * / null — content_filter degrades to end_turn since Anthropic has no such stop_reason, flagged via N3).
 */
function aggregateStopReason(sawToolUse: boolean, sawLength: boolean): StopReason {
  if (sawToolUse) return "tool_use"
  if (sawLength) return "max_tokens"
  return "end_turn"
}

/**
 * CC `usage` → Anthropic `usage`. `prompt_tokens`→`input_tokens`, `completion_tokens`→`output_tokens`;
 * best-effort forwards the GHC cache extensions (`prompt_tokens_details.cached_tokens`→cache_read,
 * `.cache_write_tokens`→cache_creation) so the client sees them (richest-data-flow). Absent usage → 0s.
 */
function mapUsage(usage: ChatCompletionUsage | undefined): TranslatedAnthropicUsage {
  if (usage === undefined) return { input_tokens: 0, output_tokens: 0 }
  const promptDetails = usage.prompt_tokens_details as { cached_tokens?: number; cache_write_tokens?: number } | undefined
  const cacheRead = promptDetails?.cached_tokens
  const cacheCreation = promptDetails?.cache_write_tokens
  return {
    // CC `prompt_tokens` is the TOTAL prompt INCLUDING cached tokens; the Anthropic wire
    // convention is that `input_tokens` is the NET uncached input, disjoint from
    // cache_read/cache_creation (usage-normalize.ts; GHC translator.py oracle). Reuse the
    // shared `netInputTokens` primitive so the cached amount is not double-counted (B1).
    input_tokens: netInputTokens(usage.prompt_tokens, cacheRead ?? 0, cacheCreation ?? 0),
    output_tokens: usage.completion_tokens,
    ...(cacheRead !== undefined && { cache_read_input_tokens: cacheRead }),
    ...(cacheCreation !== undefined && { cache_creation_input_tokens: cacheCreation }),
  }
}
