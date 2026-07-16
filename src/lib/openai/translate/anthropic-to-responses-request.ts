/**
 * Direct forward-bridge request translation: Anthropic Messages request → Responses request.
 *
 * RFC 2026-07-14-anthropic-responses-direct-bridge §3/§4.1 — the `(anthropic client, responses model)`
 * FORWARD request leg, replacing the two-hop `anthropic→cc→responses` path with a single direct
 * translation that skips the CC intermediate representation entirely (no multi-choices fold/split, no
 * CC tool_call index bookkeeping — those are CC-canonical artifacts the Responses `input[]`/`output[]`
 * shape never needs, phase-2-audit §② "须重新设计" — this file does NOT reuse
 * `anthropic-to-cc-request.ts`'s block-folding logic, only its extracted pure helpers, ① in the audit).
 *
 * Each Anthropic content block is emitted as its OWN Responses `input[]` item (message / function_call /
 * function_call_output) — no CC-style "fold text+tool_use into one message" step, matching the Responses
 * API's item-per-turn-element granularity (audit ②: Responses has no CC multi-choices concept to begin
 * with, so there is nothing to fold).
 *
 * Reused verbatim (Phase 2 audit ①, cross-format primitives with zero CC coupling):
 *   - `anthropicSystemToText` (anthropic-to-cc-request.ts) — flattens `system` → Responses `instructions`.
 *   - `clampToCcEffort` / `modelSupportsReasoningEffort` (anthropic-to-cc-request.ts) — thinking→effort
 *     tier mapping + capability gate (the "cc" in the name is a historical artifact; the mapping itself
 *     is format-agnostic — both CC `reasoning_effort` and Responses `reasoning.effort` take the same
 *     three-tier low/medium/high vocabulary).
 *   - `budgetToEffort` (thinking-coercion.ts) — budget_tokens → effort tier heuristic.
 *   - `isApiDefinedToolType` (message-tools.ts) — native server-tool type-prefix detection.
 *
 * Phase 5 (RFC §4.1 step 3, RFC 2026-07-14-anthropic-responses-direct-bridge — forward reasoning
 * round-trip): an echoed-back `thinking` block whose `signature` carries OUR sentinel envelope
 * (`synthetic-reasoning.ts`'s `isSyntheticReasoningSignature`/`extractEncryptedReasoning`, the SAME
 * forward-only primitive Phase 3's response leg used to RENDER it) is RECONSTRUCTED into a Responses
 * `reasoning` input item — see {@link reconstructReasoningInputItem}. A thinking block with a
 * non-sentinel (foreign/absent) signature is still dropped, never synthesized (R-DIRECTION-ASYMMETRY:
 * this forward leg only ever round-trips ITS OWN sentinel-signed blocks, never a real Claude signature
 * — that direction is the REVERSE leg's `claude-signature-carrier.ts`, a wholly separate primitive).
 *
 * Graceful degradation (mirrors anthropic-to-cc-request.ts's discipline, spec §1.4 "尽力而为"):
 *   - `thinking` → `reasoning.effort` (+ unconditional `summary:"auto"` so the model's reasoning is
 *     forwarded) PLUS the Phase 5 round-trip above for an echoed-back sentinel-signed block.
 *   - `cache_control` → STRIPPED (Responses has no cache-breakpoint concept).
 *   - native server tools (`web_search`, `code_execution`, …) → STRIPPED, warned (Phase 6 wires the
 *     `web_search_preview` mapping; until then this leg behaves like the CC leg — never silently drop
 *     without a warning).
 *   - `redacted_thinking` ASSISTANT blocks → dropped (Anthropic redacts it entirely, no plaintext/no
 *     sentinel to recover — nothing to round-trip).
 *   - `top_k` → dropped (no Responses equivalent).
 */

import consola from "consola"

import type { Model } from "~/lib/models/client"
import type {
  //
  ContentBlockParam,
  ImageBlockParam,
  MessageParam,
  MessagesPayload,
  Tool as AnthropicTool,
  ToolChoice as AnthropicToolChoice,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "~/types/api/anthropic"
import type {
  //
  ResponsesFunctionTool,
  ResponsesInputContentPart,
  ResponsesInputItem,
  ResponsesPayload,
  ResponsesToolChoice,
} from "~/types/api/openai-responses"

import { isApiDefinedToolType } from "~/lib/anthropic/message-tools"
import { extractEncryptedReasoning, isSyntheticReasoningSignature } from "~/lib/anthropic/synthetic-reasoning"
import { budgetToEffort } from "~/lib/anthropic/thinking-coercion"

import {
  //
  anthropicSystemToText,
  clampToCcEffort,
  modelSupportsReasoningEffort,
} from "./anthropic-to-cc-request"

/** Options for {@link translateAnthropicToResponses} — mirrors `AnthropicToCcOptions` (same two knobs). */
export interface AnthropicToResponsesOptions {
  /** The resolved upstream model — gates the `thinking` → `reasoning.effort` mapping. */
  model?: Model
  /** The originating request id (`ctx.id`), threaded purely to TAG lossy-drop warnings for traceability. */
  reqId?: string
}

/** Emit an `[Anthropic→Responses]` lossy-drop warning, tagged with `requestId=<reqId>` when known. */
function dropWarn(message: string, reqId: string | undefined): void {
  consola.warn(`[Anthropic→Responses] ${message}${reqId ? ` requestId=${reqId}` : ""}`)
}

/**
 * Translate an Anthropic Messages payload directly into a Responses payload (RFC §3/§4.1 front-leg bridge).
 *
 * Produces the logical Responses body only (the effectiveRequest track) — the upstream endpoint's
 * last-mile shaping (`max_output_tokens` fill, header build) stays in `prepareResponsesRequest`.
 */
export function translateAnthropicToResponses(payload: MessagesPayload, opts?: AnthropicToResponsesOptions): ResponsesPayload {
  const reqId = opts?.reqId
  const instructions = anthropicSystemToText(payload.system)

  const input: Array<ResponsesInputItem> = []
  for (const message of payload.messages) input.push(...translateMessage(message, reqId))

  const tools = payload.tools ? translateTools(payload.tools, reqId) : undefined
  const toolChoice = payload.tool_choice ? translateToolChoice(payload.tool_choice) : undefined
  const reasoning = translateThinkingToReasoning(payload, opts?.model)

  // Intentional drops (Anthropic-only, no Responses equivalent):
  //   NOTE: payload.top_k              — Responses has no top_k
  //   NOTE: payload.stop_sequences     — Responses has no stop-sequence concept
  //   NOTE: payload.cache_control      — stripped at the block/tool level (see translate* helpers)
  //   NOTE: payload.context_management — Anthropic/GHC-only compaction config
  //   NOTE: payload.output_config      — folded into reasoning.effort above; no Responses mirror otherwise
  return {
    model: payload.model,
    input,
    ...(instructions.length > 0 && { instructions }),
    max_output_tokens: payload.max_tokens,
    ...(payload.temperature !== undefined && { temperature: payload.temperature }),
    ...(payload.top_p !== undefined && { top_p: payload.top_p }),
    ...(payload.stream !== undefined && { stream: payload.stream }),
    ...(reasoning !== undefined && { reasoning }),
    ...(tools && tools.length > 0 && { tools }),
    ...(toolChoice !== undefined && { tool_choice: toolChoice }),
    ...(payload.metadata?.user_id !== undefined && { user: payload.metadata.user_id }),
  }
}

// ============================================================================
// Messages / content blocks → Responses input items
// ============================================================================

/**
 * Translate one Anthropic message into 0+ Responses `input[]` items. Unlike the CC leg (which FOLDS an
 * assistant turn's text+tool_use into one CC message), each block becomes its OWN Responses item —
 * Responses' `output[]`/`input[]` granularity is per-item, not per-turn (audit ②: no fold/split state
 * machine needed here, that machinery is CC-canonical-only).
 */
function translateMessage(message: MessageParam, reqId: string | undefined): Array<ResponsesInputItem> {
  if (typeof message.content === "string") {
    if (message.content.length === 0) return []
    return [{ type: "message", role: message.role, content: [{ type: "input_text", text: message.content }] }]
  }

  const blocks = message.content
  return message.role === "assistant" ? translateAssistantBlocks(blocks, reqId) : translateUserBlocks(blocks, reqId)
}

/**
 * Assistant turn: each text block → a `message` item; each tool_use → a `function_call` item (block
 * order preserved); a hitherto-forwarded `thinking` block whose `signature` carries OUR sentinel
 * envelope (Phase 3's `buildSyntheticReasoningSignature`) is RECONSTRUCTED into a `reasoning` input
 * item (RFC §4.1 step 3, Phase 5 forward round-trip) — the client echoing back exactly the block we
 * rendered on a prior turn. Reasoning items are emitted FIRST (Responses' own convention: a reasoning
 * item precedes the message/function_call items of the same turn, mirrored from the non-streaming
 * response leg's `unshift`, `anthropic-to-responses.ts`).
 *
 * A `thinking` block with NO sentinel signature (a real, non-ours block — should never happen on this
 * leg since Responses models never emit real Anthropic signatures, but defensive nonetheless) is
 * dropped, not synthesized — mirrors the pre-Phase-5 forward drop for anything outside our own
 * round-trip contract.
 */
function translateAssistantBlocks(blocks: Array<ContentBlockParam>, reqId: string | undefined): Array<ResponsesInputItem> {
  const items: Array<ResponsesInputItem> = []
  const reasoningItems: Array<ResponsesInputItem> = []
  const textParts: Array<string> = []

  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        textParts.push(block.text)
        break
      }
      case "tool_use": {
        items.push(toolUseToFunctionCall(block))
        break
      }
      case "thinking": {
        const reconstructed = reconstructReasoningInputItem(block, reqId)
        if (reconstructed) reasoningItems.push(reconstructed)
        break
      }
      case "redacted_thinking": {
        // No round-trip carrier for a redacted block (Anthropic redacts it entirely, no plaintext/no
        // sentinel to recover) — benign forward drop, mirrors the CC leg's same drop.
        break
      }
      case "server_tool_use": {
        dropWarn(`dropping server_tool_use block "${(block as { name?: string }).name ?? "unknown"}" (no Responses equivalent yet — Phase 6)`, reqId)
        break
      }
      default: {
        break
      }
    }
  }

  if (textParts.length > 0) items.unshift({ type: "message", role: "assistant", content: [{ type: "output_text", text: textParts.join("") }] })
  items.unshift(...reasoningItems)
  return items
}

/**
 * Reconstruct a Responses `reasoning` input item from an echoed-back synthetic-reasoning `thinking`
 * block (Phase 5 forward round-trip, RFC §4.1 step 3). Only fires for OUR sentinel-signed blocks
 * (`isSyntheticReasoningSignature`) — a thinking block with a foreign/absent signature is not ours to
 * reconstruct (dropped by the caller, never synthesized). `extractEncryptedReasoning` recovers the
 * REAL upstream `encrypted_content` the sentinel envelope carried (Phase 3's `.done`-captured
 * authoritative blob) — undefined payload (bare-prefix block, no `encrypted_content` was captured)
 * still reconstructs a valid reasoning item with just the summary text, since a Responses reasoning
 * item's `encrypted_content` is optional (RFC §7.2 probe (a): the upstream accepts empty/absent too).
 */
function reconstructReasoningInputItem(block: Extract<ContentBlockParam, { type: "thinking" }>, reqId: string | undefined): ResponsesInputItem | undefined {
  if (!isSyntheticReasoningSignature(block.signature)) {
    dropWarn("dropping a thinking block with a non-sentinel signature (not ours to round-trip — no synthesis)", reqId)
    return undefined
  }
  const encryptedContent = extractEncryptedReasoning(block.signature)
  return {
    type: "reasoning",
    summary: block.thinking.length > 0 ? [{ type: "summary_text", text: block.thinking }] : [],
    ...(encryptedContent !== undefined && { encrypted_content: encryptedContent }),
  }
}

/** User turn: each tool_result → its own `function_call_output` item; remaining text/image → a `message` item. */
function translateUserBlocks(blocks: Array<ContentBlockParam>, reqId: string | undefined): Array<ResponsesInputItem> {
  const items: Array<ResponsesInputItem> = []
  const userParts: Array<ResponsesInputContentPart> = []

  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        userParts.push({ type: "input_text", text: block.text })
        break
      }
      case "image": {
        userParts.push(imageBlockToInputPart(block))
        break
      }
      case "tool_result": {
        items.push(toolResultToFunctionCallOutput(block, reqId))
        break
      }
      default: {
        // thinking/redacted_thinking on a user turn is non-standard; server_tool_result blocks are
        // server-side artifacts — no Responses equivalent, drop (mirrors the CC leg).
        break
      }
    }
  }

  if (userParts.length > 0) items.push({ type: "message", role: "user", content: userParts })
  return items
}

/** Anthropic `tool_use` block → Responses `function_call` item (arguments = JSON.stringify(input)). */
function toolUseToFunctionCall(block: ToolUseBlockParam): ResponsesInputItem {
  return { type: "function_call", id: block.id, call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }
}

/**
 * Anthropic `tool_result` block → Responses `function_call_output` item.
 *
 * `content` may be a string OR an array of blocks (text / image). Responses `function_call_output.output`
 * is a plain string, so text blocks are concatenated; images inside a tool_result have no clean Responses
 * slot and are dropped (warned — mirrors the CC leg). An `is_error` result is prefixed so the model still
 * sees it failed (same convention as the CC leg's `[tool_error]` prefix).
 */
function toolResultToFunctionCallOutput(block: ToolResultBlockParam, reqId: string | undefined): ResponsesInputItem {
  let text: string
  if (typeof block.content === "string") {
    text = block.content
  } else if (Array.isArray(block.content)) {
    const textPieces: Array<string> = []
    let droppedImages = 0
    for (const part of block.content) {
      if (part.type === "text") textPieces.push(part.text)
      else if (part.type === "image") droppedImages++
    }
    if (droppedImages > 0) dropWarn(`tool_result ${block.tool_use_id}: dropped ${droppedImages} image block(s) (no Responses function_call_output slot)`, reqId)
    text = textPieces.join("")
  } else {
    text = ""
  }

  return { type: "function_call_output", call_id: block.tool_use_id, output: block.is_error ? `[tool_error] ${text}` : text }
}

/** Anthropic `image` block → Responses `input_image` content part (base64 → data URL, url passthrough). */
function imageBlockToInputPart(block: ImageBlockParam): ResponsesInputContentPart {
  const source = block.source
  const url = source.type === "base64" ? `data:${source.media_type};base64,${source.data}` : source.url
  return { type: "input_image", image_url: url }
}

// ============================================================================
// Tools / tool_choice
// ============================================================================

/**
 * Anthropic `tools[]` → Responses function tools. Native server tools (`web_search`, `code_execution`, …)
 * are STRIPPED (warned) until Phase 6 wires the `web_search_preview` mapping — matches the CC leg's
 * current behavior so this Phase does not regress server-tool handling, it just doesn't yet improve it.
 */
function translateTools(tools: Array<AnthropicTool>, reqId: string | undefined): Array<ResponsesFunctionTool> {
  const out: Array<ResponsesFunctionTool> = []
  for (const tool of tools) {
    if (isApiDefinedToolType(tool.type)) {
      dropWarn(`dropping native server tool "${tool.name}" (type: ${tool.type}) — unsupported on the direct Responses bridge (Phase 6)`, reqId)
      continue
    }
    out.push({
      type: "function",
      name: tool.name,
      ...(tool.description !== undefined && { description: tool.description }),
      ...(tool.input_schema !== undefined && { parameters: tool.input_schema }),
    })
  }
  return out
}

/** Anthropic `tool_choice` → Responses `tool_choice` (same vocabulary as the CC leg's mapping). */
function translateToolChoice(choice: AnthropicToolChoice): ResponsesToolChoice {
  switch (choice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      // Anthropic "any" = must call SOME tool → Responses "required".
      return "required"
    }
    case "none": {
      return "none"
    }
    case "tool": {
      return { type: "function", name: choice.name }
    }
    default: {
      // Exhaustive over the ToolChoice union; a future variant falls back to "auto".
      return "auto"
    }
  }
}

// ============================================================================
// Thinking → reasoning.effort
// ============================================================================

/**
 * Map Anthropic `thinking` → Responses `reasoning.effort` + unconditional `summary:"auto"` (so the
 * model's displayable reasoning summary streams back — matches the CC→Responses wire step's existing
 * `reasoning:{effort,summary:"auto"}` construction, `cc-to-responses.ts:80`). `enabled{budget_tokens}`
 * uses the shared budget→tier heuristic; `adaptive` uses `output_config.effort`; `disabled`/absent →
 * undefined. Gated on the model's `supports.reasoning_effort` whitelist when a model is supplied.
 */
function translateThinkingToReasoning(payload: MessagesPayload, model: Model | undefined): ResponsesPayload["reasoning"] {
  const thinking = payload.thinking
  if (!thinking || thinking.type === "disabled") return undefined

  let effort: "low" | "medium" | "high" | undefined
  if (thinking.type === "enabled") {
    effort = budgetToEffort(thinking.budget_tokens)
  } else {
    // adaptive (opus 4.6+): the intensity lives in output_config.effort.
    effort = clampToCcEffort(payload.output_config?.effort)
  }
  if (effort === undefined) return undefined
  if (model !== undefined && !modelSupportsReasoningEffort(model)) return undefined

  return { effort, summary: "auto" }
}
