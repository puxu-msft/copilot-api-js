/**
 * Direct reverse-bridge response translation: Anthropic Messages response → Responses response.
 *
 * RFC 2026-07-14-anthropic-responses-direct-bridge §3/§4.2 — the `(openai-responses client, /v1/messages)`
 * REVERSE non-streaming response leg, replacing the two-hop `anthropic→cc→responses` translation with a
 * single direct walk of Anthropic `content[]` straight into Responses `output[]` items.
 *
 * Direction (the mirror of `responses-to-anthropic.ts`, the forward-leg response translator, Phase 3):
 *   upstream Anthropic response ─► translateAnthropicResponseToResponses ─► client Responses response
 *
 * Reused (Phase 2/3 audit ①, cross-format primitives — physically imported): none of the request-side
 * repair/image/tool_choice primitives apply here — Anthropic `tool_use.input` is already a parsed object
 * (no JSON-string repair surface, unlike the request-side legs). The usage gross-up arithmetic below
 * mirrors `anthropic-to-cc.ts`'s `mapUsage` convention (`promptTokens = inputTokens + cacheRead +
 * cacheCreation`) — the SAME shared convention, run forward instead of backward (Phase 3's
 * `netInputTokens`/`usageFromTotalInput` are the SUBTRACT direction and don't directly apply to this
 * ADD-BACK direction, so this file reimplements the small forward arithmetic inline rather than force-fit
 * a mismatched-direction primitive).
 *
 * ⚠️ R-DIRECTION-ASYMMETRY (RFC §4.4 — reasoning rendering + Phase 5 round-trip carrier):
 * A Claude `thinking` block carries a REAL, Anthropic-signed `signature` (never a sentinel — that's the
 * FORWARD leg's哨兵合成, Phase 3, a different mechanism entirely). This leg renders the thinking block's
 * PLAINTEXT `thinking` text as a Responses `reasoning` output item's `summary` (richest-data-flow: the
 * client sees the model's visible reasoning, never silently dropped) AND carries the real `signature`
 * BYTE-EXACT in `encrypted_content` via `claude-signature-carrier.ts` — a wholly separate, non-shared
 * primitive from the forward leg's `synthetic-reasoning.ts` sentinel envelope (probe (e),
 * exp/anthropic-responses-direct/FINDINGS.md: Claude's upstream rejects a signature altered by even ONE
 * byte, so this carrier must be lossless). `redacted_thinking` has no signature field to carry (Anthropic
 * redacts it entirely) — it renders no reasoning item at all (nothing to forward).
 *
 * Per-block (not merged): EACH `thinking` block becomes its OWN reasoning output item (its own id +
 * carrier), matching the streaming leg's existing per-`content_block` granularity — a turn with multiple
 * thinking blocks (interleaved with text/tool_use) no longer collapses them into a single accumulated
 * reasoning item.
 */

import type { StopReason } from "@anthropic-ai/sdk/resources/messages"

import type {
  //
  ContentBlock,
  Message as AnthropicResponse,
} from "~/types/api/anthropic"
import type {
  //
  ResponsesFunctionCallOutput,
  ResponsesOutputItem,
  ResponsesReasoningOutput,
  ResponsesResponse,
  ResponsesUsage,
} from "~/types/api/openai-responses"

import type { TranslateExchangeContext } from "./responses-to-cc-request"

import { buildClaudeSignatureCarrier } from "~/lib/anthropic/claude-signature-carrier"

/**
 * Translate an Anthropic Messages response into a Responses response (REVERSE leg, direct bridge).
 *
 * `ctx` reuses the SAME `TranslateExchangeContext` shape the existing CC-intermediate reverse leg
 * (`responses-to-cc-request.ts`) and the codec's exchange-building closure already produce — the direct
 * bridge is a drop-in replacement for `translateCCToResponsesResponse`, not a new exchange-management
 * contract (RFC §2.3: this reverse response leg slots into the SAME `ensureReverseExchange` wiring the
 * codec already has, ADR-consistent: one exchange-context shape for both the CC-intermediate and direct
 * bridges avoids a second, parallel id-management convention).
 *
 * A single ordered walk of `content[]` — Anthropic already has ONE turn's blocks in one array (no CC
 * multi-choices fold/split to undo, symmetric with the forward leg's simplicity, phase-2-audit §②).
 * `thinking` blocks become a LEADING `reasoning` output item (Responses' own convention — Phase 0 FINDINGS
 * observed reasoning items precede the message/function_call items in a real Responses output[]).
 */
export function translateAnthropicResponseToResponses(response: AnthropicResponse, ctx: TranslateExchangeContext): ResponsesResponse {
  const output: Array<ResponsesOutputItem> = []
  const reasoningItems: Array<ResponsesReasoningOutput> = []
  let reasoningIndex = 0
  let hasToolCalls = false

  for (const block of response.content) {
    switch (block.type) {
      case "thinking": {
        // Per-block (not merged): each thinking block gets its OWN reasoning item, id, and signature
        // carrier — matches the streaming leg's per-content_block granularity (Phase 5 unification).
        const carrier = buildClaudeSignatureCarrier(block.signature)
        reasoningItems.push({
          type: "reasoning",
          id: `${ctx.itemId}_reasoning_${reasoningIndex++}`,
          summary: block.thinking.length > 0 ? [{ type: "summary_text", text: block.thinking }] : [],
          ...(carrier !== undefined && { encrypted_content: carrier }),
        })
        break
      }
      case "redacted_thinking": {
        // No plaintext to render (Anthropic redacts it entirely) — nothing to forward; not an error.
        break
      }
      case "text": {
        output.push({
          id: ctx.itemId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: block.text, annotations: [] }],
        })
        break
      }
      case "tool_use": {
        output.push(toolUseBlockToFunctionCall(block))
        hasToolCalls = true
        break
      }
      default: {
        // server_tool_use / *_tool_result / any future block type — no Responses output-item equivalent
        // on this leg (server-tool passthrough is Phase 6 scope) — drop (never throws for an additive
        // upstream block, mirrors the forward leg's same discipline).
        break
      }
    }
  }

  // Leading reasoning items — Responses' own convention (Phase 0 probe observed reasoning items precede
  // message/function_call items). Emitted in block order, all BEFORE the rest of the turn's output.
  output.unshift(...reasoningItems)

  const { status, incompleteReason } = mapStopReasonToResponsesStatus(response.stop_reason, hasToolCalls)

  return {
    id: ctx.responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: response.model || ctx.clientModel,
    output,
    usage: mapUsage(response.usage),
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    ...(incompleteReason && { incomplete_details: { reason: incompleteReason } }),
  }
}

// ============================================================================
// tool_use → function_call
// ============================================================================

/** Anthropic `tool_use` block → Responses `function_call` output item (id passed through verbatim as call_id — mirrors the forward leg). */
function toolUseBlockToFunctionCall(block: Extract<ContentBlock, { type: "tool_use" }>): ResponsesFunctionCallOutput {
  return { type: "function_call", id: block.id, call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}), status: "completed" }
}

// ============================================================================
// stop_reason → status/incomplete_details (single hop, no CC intermediate)
// ============================================================================

/**
 * Map Anthropic's 6-value `StopReason` directly to Responses' `status`+`incomplete_details.reason`, in
 * ONE hop (no CC `finish_reason` intermediate to degrade through — audit ③, mirrors the forward leg's
 * `mapResponsesStatusToStopReason` discipline in the opposite direction).
 *
 * `tool_use` wins regardless (a tool turn) → `completed` (Responses has no separate "tool-call" status;
 * the function_call output items themselves ARE the signal, mirrors the CC-intermediate leg's
 * `ccFinishReasonToResponsesStatus` treating `tool_calls`/`function_call` as `completed` too — this is
 * NOT a degradation, Responses genuinely has no distinct tool-call status).
 * `end_turn` / `stop_sequence` → `completed` (both are natural-stop reasons Responses folds into one status).
 * `max_tokens` → `incomplete` + `max_output_tokens` reason (faithful, symmetric with the forward leg).
 * `pause_turn` → `incomplete` + a NEW, HONEST `pause_turn` reason string — Responses has no dedicated
 * pause-turn incomplete reason (its own vocabulary is `max_output_tokens`/`content_filter` only), so
 * rather than silently folding this DISTINCT Anthropic-only signal into `max_output_tokens` (a fidelity
 * loss disguised as a match) or dropping it as `completed` (an even worse fidelity loss — the turn did
 * NOT actually finish), this maps it to `incomplete` with a reason string that says what actually
 * happened. A Responses client reading an unrecognized incomplete_details.reason value degrades
 * gracefully (it's an open string field, not a closed enum on the wire) — never a wire error.
 * `refusal` → `incomplete` + a NEW, HONEST `refusal` reason string (same reasoning: Responses' own
 * `part.type==="refusal"` is a DIFFERENT concept — an output CONTENT shape, not a completion status —
 * so there is no existing Responses status vocabulary word for "a stop-classifier refused mid-stream";
 * inventing an honest string beats silently mapping to content_filter, WHICH WOULD BE WRONG per Phase 3's
 * corrected finding that content_filter and refusal are themselves two distinct concepts — reusing that
 * mismatch here would repeat the exact error Phase 3 fixed, just in the opposite direction).
 *
 * Exported: the streaming translator (`anthropic-to-responses-stream.ts`, subtask F) reuses this SAME
 * mapping for its terminal `message_delta` — one source of truth (fix-all-comparison-sites), never a
 * copy-paste (mirrors subtask C's reuse of subtask B's `mapResponsesStatusToStopReason`/`mapUsage`).
 */
export function mapStopReasonToResponsesStatus(
  stopReason: StopReason | null,
  hasToolCalls: boolean,
): { status: ResponsesResponse["status"]; incompleteReason?: string } {
  if (hasToolCalls) return { status: "completed" }
  switch (stopReason) {
    case "max_tokens": {
      return { status: "incomplete", incompleteReason: "max_output_tokens" }
    }
    case "pause_turn": {
      return { status: "incomplete", incompleteReason: "pause_turn" }
    }
    case "refusal": {
      return { status: "incomplete", incompleteReason: "refusal" }
    }
    default: {
      // end_turn / stop_sequence / null — natural-stop reasons Responses folds into one status.
      return { status: "completed" }
    }
  }
}

// ============================================================================
// usage
// ============================================================================

/**
 * Anthropic `usage` → Responses `usage` (audit ③: field-name reassembly + gross-up). Anthropic's
 * `input_tokens` is NET-of-cache (disjoint from `cache_read_input_tokens`/`cache_creation_input_tokens`),
 * but Responses' `input_tokens` is TOTAL-including-cache (same convention as CC's `prompt_tokens` —
 * mirrors `anthropic-to-cc.ts`'s `mapUsage` gross-up, `promptTokens = inputTokens + cacheRead +
 * cacheCreation`, reused here for the SAME reason: a downstream `netInputTokens` re-read of this Responses
 * usage must recover the correct net figure, not double-subtract). This is the ADD-BACK direction — the
 * inverse of Phase 3's `netInputTokens`/`usageFromTotalInput` SUBTRACT direction, so those primitives
 * don't directly apply here (they'd immediately undo the gross-up); the arithmetic itself is still the
 * SAME shared convention, just run forward instead of backward.
 *
 * `output_tokens_details.reasoning_tokens` is populated from Anthropic's OWN `output_tokens_details.
 * thinking_tokens` (a REAL Anthropic field, not a GHC-only extension — confirmed against the
 * `@anthropic-ai/sdk` `OutputTokensDetails` type) — MUST NOT be silently dropped (Phase 3 MAJOR fix
 * precedent: an earlier version of the forward leg dropped this exact class of field).
 *
 * Exported: the streaming translator (subtask F) reuses this SAME projection for its terminal usage.
 */
export function mapUsage(usage: AnthropicResponse["usage"]): ResponsesUsage {
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheCreation = usage.cache_creation_input_tokens ?? 0
  const totalInput = usage.input_tokens + cacheRead + cacheCreation
  const reasoningTokens = usage.output_tokens_details?.thinking_tokens
  return {
    input_tokens: totalInput,
    output_tokens: usage.output_tokens,
    total_tokens: totalInput + usage.output_tokens,
    ...((cacheRead > 0 || cacheCreation > 0) && {
      input_tokens_details: { ...(cacheRead > 0 && { cached_tokens: cacheRead }), ...(cacheCreation > 0 && { cache_write_tokens: cacheCreation }) },
    }),
    ...(reasoningTokens !== undefined && reasoningTokens > 0 && { output_tokens_details: { reasoning_tokens: reasoningTokens } }),
  }
}
