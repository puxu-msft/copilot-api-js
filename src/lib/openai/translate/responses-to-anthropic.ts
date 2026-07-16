/**
 * Direct forward-bridge response translation: Responses response → Anthropic Messages response.
 *
 * RFC 2026-07-14-anthropic-responses-direct-bridge §3/§4.1 — the `(anthropic client, responses model)`
 * FORWARD non-streaming response leg, replacing the two-hop `responses→cc→anthropic` translation with a
 * single direct walk of `output[]` straight into Anthropic content blocks (phase-2-audit §② "须重新设计":
 * Responses' `output[]` has no CC multi-choices split to undo — a single ordered walk suffices, simpler
 * than the CC leg's fold-then-refold).
 *
 * Reused verbatim (Phase 2 audit ①, cross-format primitives):
 *   - `repairToolInput` (tool-input-repair.ts) — malformed `function_call.arguments` JSON repair cascade.
 *   - `netInputTokens` (usage-normalize.ts) — Responses `input_tokens` already excludes cache (unlike CC's
 *     `prompt_tokens`, which INCLUDES it) — see the usage section below, phase-2-audit §③.
 *   - `buildSyntheticReasoningSignature` (synthetic-reasoning.ts) — the sentinel-signed thinking-block
 *     envelope (forward direction only, R-DIRECTION-ASYMMETRY — this Phase does NOT do encrypted_content
 *     round-trip; Phase 5 wires that in, this bridge only forwards the DISPLAYABLE summary text).
 *
 * stop_reason / status (phase-2-audit §③, "须重新推导" — NOT continuing the CC hop's degradation for
 * `refusal`/`pause_turn`, but SHARING the N3 convention for `content_filter`, corrected against a
 * user-cited code-level counter-argument post-subtask-B review): mapped in a SINGLE hop from Responses
 * `status`+`incomplete_details.reason` straight to Anthropic's `StopReason` — see
 * {@link mapResponsesStatusToStopReason}. The CC hop's `mapIncompleteFinishReason` (responses-to-cc.ts)
 * collapses `max_output_tokens` through CC's narrower `FinishReason` (`length`) before the CC→Anthropic
 * leg maps it to `max_tokens` — this direct bridge reproduces the SAME faithful `max_tokens` result in one
 * hop (no degradation either way, just fewer hops).
 *
 * ⚠️ `content_filter` is NOT mapped to Anthropic's `refusal` stop_reason (an EARLIER version of this file
 * did — corrected). `refusal` and `content_filter` are two DISTINCT concepts even within the Responses
 * API's own model: a Responses `part.type==="refusal"` (the model's own structured-output refusal, handled
 * separately below as a text-block passthrough) is NOT the same thing as `incomplete_details.reason===
 * "content_filter"` (a moderation-layer truncation). Mapping the latter to Anthropic's `refusal` would be
 * a SEMANTIC MISMATCH (conflating two concepts Responses itself keeps separate), not a fidelity gain.
 * Anthropic genuinely has NO `content_filter` stop_reason (`cc-to-anthropic.ts` records this explicitly:
 * "Anthropic has no such stop_reason") — this is the SAME physical gap the whole codebase already has a
 * settled answer for: N3 (`end_turn` on the wire + the `contentFiltered` ctx marker, "distinguishable via
 * observability, not by inventing a wire value that doesn't mean the same thing"). This bridge REUSES
 * that N3 convention rather than reinventing a new (wrong) one — the `contentFiltered` result field below
 * IS the distinguishability RFC/audit asked for, just via ctx instead of a mismatched wire stop_reason.
 *
 * `tool_calls` wins regardless of status (a tool turn — mirrors both the CC-leg's `hasToolCalls` override
 * and `responses-to-cc.ts`'s `mapFinishReason`). Anthropic's OWN `pause_turn` has no Responses equivalent
 * either (Responses has no mid-turn-pause status distinct from `incomplete`/`completed`) — unreachable
 * from a genuine Responses response, so intentionally not modeled as a mapping target (same reasoning as
 * `content_filter`, just without an N3-equivalent ctx marker since nothing is actually lost — there is no
 * Responses-side signal to preserve).
 *
 * usage (phase-2-audit §③, "须重新推导" — precision matches, arithmetic is shared ①): Responses
 * `input_tokens` is the TOTAL prompt INCLUDING cached tokens (same convention as CC's `prompt_tokens`),
 * so the shared `netInputTokens`/cache-subtraction primitive from usage-normalize.ts applies UNCHANGED —
 * only the outer field names differ (Responses `input_tokens_details.cached_tokens`/`.cache_write_tokens`
 * vs Anthropic `cache_read_input_tokens`/`cache_creation_input_tokens`), which this file assembles fresh
 * (no CC intermediate `prompt_tokens_details` to re-read).
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
  ResponsesOutputItem,
  ResponsesResponse,
  ResponsesUsage,
} from "~/types/api/openai-responses"

import { buildSyntheticReasoningSignature } from "~/lib/anthropic/synthetic-reasoning"
import { repairToolInput } from "~/lib/anthropic/tool-input-repair"
import { HTTPError } from "~/lib/error"
import { netInputTokens } from "~/lib/request/usage-normalize"

/** The default repair cascade for a malformed `function_call.arguments` JSON string (mirrors cc-to-anthropic.ts). */
const RESPONSE_TOOL_REPAIR_ITEMS = ["tags", "unicode", "jsonrepair"] as const

/** A translated Anthropic response content block (the shapes a Responses output[] walk yields). */
type AnthropicResponseBlock = ThinkingBlockParam | TextBlockParam | ToolUseBlockParam

/** The Anthropic Messages response shape produced from a Responses response (mirrors `TranslatedAnthropicResponse`). */
export interface TranslatedAnthropicResponseFromResponses {
  id: string
  type: "message"
  role: "assistant"
  model: string
  content: Array<AnthropicResponseBlock>
  stop_reason: StopReason
  stop_sequence: string | null
  usage: TranslatedAnthropicUsageFromResponses
}

/** Anthropic usage projected from Responses usage (input/output + best-effort cache tokens). */
export interface TranslatedAnthropicUsageFromResponses {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** The distinguishable degradations the codec surfaces as ctx markers (N3 parity with the CC leg). */
export interface ResponsesToAnthropicResult {
  response: TranslatedAnthropicResponseFromResponses
  /** TRUE when the Responses status finished `incomplete` with reason `content_filter` (N3 parity). */
  contentFiltered: boolean
}

/**
 * Translate a Responses response into an Anthropic Messages response (direct forward-bridge, non-streaming).
 *
 * A single ordered walk of `output[]` — no CC multi-choices fold/split needed (Responses' output items
 * are already per-element, unlike CC's choices[] split). Reasoning items become a LEADING synthetic
 * thinking block (Anthropic requires thinking first); message/function_call items follow in order.
 */
export function translateResponsesResponseToAnthropic(response: ResponsesResponse): ResponsesToAnthropicResult {
  if (response.status === "failed") {
    const message = response.error?.message ?? "Upstream response failed"
    throw new HTTPError(message, 500, JSON.stringify(response.error ?? { status: response.status }), response.model)
  }

  const content: Array<AnthropicResponseBlock> = []
  let reasoningText = ""
  let reasoningEncrypted: string | undefined
  let hasToolCalls = false

  for (const item of response.output) {
    switch (item.type) {
      case "reasoning": {
        for (const s of item.summary) if (s.text) reasoningText += s.text
        if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) reasoningEncrypted = item.encrypted_content
        break
      }
      case "message": {
        for (const part of item.content) {
          if (part.type === "output_text" && part.text.length > 0) content.push({ type: "text", text: part.text } satisfies TextBlockParam)
          // A structured-output refusal carries text — forward it as a text block (never-swallow /
          // richest-data-flow; mirrors the CC leg forwarding `message.refusal`).
          if (part.type === "refusal" && part.refusal.length > 0) content.push({ type: "text", text: part.refusal } satisfies TextBlockParam)
        }
        break
      }
      case "function_call": {
        content.push(functionCallToToolUseBlock(item))
        hasToolCalls = true
        break
      }
      default: {
        // Exhaustive over the current ResponsesOutputItem union; a future item type not yet modeled
        // degrades to a silent no-op HERE rather than throwing (never-swallow at the block level would
        // be over-eager for an additive upstream field — the response as a whole still renders).
        break
      }
    }
  }

  // Real Anthropic responses ALWAYS carry ≥1 content block (mirrors cc-to-anthropic.ts's same guard).
  if (content.length === 0) content.push({ type: "text", text: "" } satisfies TextBlockParam)

  // Prepend the synthetic reasoning (thinking) block, if any — Anthropic requires thinking FIRST.
  if (reasoningText.length > 0) {
    content.unshift({ type: "thinking", thinking: reasoningText, signature: buildSyntheticReasoningSignature(reasoningEncrypted) } satisfies ThinkingBlockParam)
  }

  const contentFiltered = response.status === "incomplete" && response.incomplete_details?.reason === "content_filter"

  return {
    response: {
      id: response.id,
      type: "message",
      role: "assistant",
      model: response.model,
      content,
      stop_reason: mapResponsesStatusToStopReason(response.status, response.incomplete_details, hasToolCalls),
      stop_sequence: null,
      usage: response.usage ? mapUsage(response.usage) : { input_tokens: 0, output_tokens: 0 },
    },
    contentFiltered,
  }
}

// ============================================================================
// function_call → tool_use
// ============================================================================

/** Responses `function_call` output item → Anthropic `tool_use` block (call_id passed through as the Anthropic tool_use id). */
function functionCallToToolUseBlock(item: Extract<ResponsesOutputItem, { type: "function_call" }>): ToolUseBlockParam {
  return { type: "tool_use", id: item.call_id, name: item.name, input: parseToolArguments(item.arguments) }
}

/**
 * Parse a Responses `function_call.arguments` JSON string → Anthropic `input` object. A malformed string
 * runs the shared battle-tested repair cascade; an unrepairable result degrades to `{}` (never throws).
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
// status/incomplete_details → stop_reason (single hop — audit ③, no CC degradation inherited)
// ============================================================================

/**
 * Map a Responses `status` (+ `incomplete_details.reason` when `incomplete`) directly to an Anthropic
 * `StopReason`, in ONE hop. `tool_calls` wins regardless of status (a tool turn — mirrors both the
 * CC-leg's `hasToolCalls` override and `responses-to-cc.ts`'s `mapFinishReason`). `content_filter` maps
 * to `end_turn` — NOT `refusal` (corrected post-review: `refusal` is a distinct Responses-native concept,
 * see the module docstring's N3 discussion above) — the `contentFiltered` result field is how this
 * distinguishability is surfaced instead (N3 convention, matches `cc-to-anthropic.ts` project-wide).
 * `max_output_tokens` → `max_tokens`. `completed`/any other reachable status → `end_turn` (Anthropic's
 * `pause_turn` has no Responses equivalent — unreachable from a genuine Responses response, intentionally
 * not modeled as a mapping target).
 *
 * Exported: the streaming translator (`responses-to-anthropic-stream.ts`) reuses this SAME mapping for
 * its terminal `response.completed`/`.incomplete` events — one source of truth (fix-all-comparison-sites),
 * never a copy-paste (mirrors `mapStopReason`/`mapUsage` in `cc-to-anthropic.ts` being shared with the
 * streaming translator there).
 */
export function mapResponsesStatusToStopReason(
  status: ResponsesResponse["status"],
  incompleteDetails: { reason: string } | null | undefined,
  hasToolCalls: boolean,
): StopReason {
  if (hasToolCalls) return "tool_use"
  if (status === "incomplete" && incompleteDetails?.reason !== "content_filter") return "max_tokens"
  // "completed" / "cancelled" / incomplete+content_filter / any future status — the most-faithful
  // reachable default. content_filter's distinguishability lives in the `contentFiltered` result field
  // (N3), not the wire stop_reason (Anthropic has none that means the same thing).
  return "end_turn"
}

// ============================================================================
// usage
// ============================================================================

/**
 * Responses `usage` → Anthropic `usage` (audit ③: field-name reassembly, arithmetic reused ① unchanged).
 * Responses `input_tokens` is the TOTAL prompt INCLUDING cached tokens (same convention as CC's
 * `prompt_tokens`) — `netInputTokens` subtracts the cache legs so Anthropic's net-input convention holds
 * (mirrors `cc-to-anthropic.ts`'s `mapUsage`, just reading Responses' own field names directly instead of
 * CC's `prompt_tokens_details` re-projection).
 *
 * Exported: the streaming translator's non-streaming-shaped usage projection (the CLIENT WIRE
 * `message_delta.usage`, which mirrors this non-streaming shape, NOT the richer history `UsageData`)
 * reuses this for the terminal `response.completed`/`.incomplete` events.
 */
export function mapUsage(usage: ResponsesUsage): TranslatedAnthropicUsageFromResponses {
  const cacheRead = usage.input_tokens_details?.cached_tokens
  const cacheCreation = usage.input_tokens_details?.cache_write_tokens
  return {
    input_tokens: netInputTokens(usage.input_tokens, cacheRead ?? 0, cacheCreation ?? 0),
    output_tokens: usage.output_tokens,
    ...(cacheRead !== undefined && { cache_read_input_tokens: cacheRead }),
    ...(cacheCreation !== undefined && { cache_creation_input_tokens: cacheCreation }),
  }
}
