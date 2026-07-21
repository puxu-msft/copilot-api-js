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
 *   - native server tools (RFC §5 / Phase 6): a per-type MAPPING TABLE ({@link SERVER_TOOL_MAPPING})
 *     translates the true server-executed Anthropic tools (`web_search`, `web_fetch`, `code_execution` —
 *     NOT the client-executed `memory`/`computer`/`text_editor`/`bash` builtins that share the same
 *     API-defined-type prefix convention, ADR 2026-07-13-server-tool-positioning §Part-1) to their
 *     Responses builtin-tool counterpart, letting the Responses upstream execute them NATIVELY (no
 *     double-hop impersonation — R-NO-REVIVE only guards the RESULT-rendering side, §5 in
 *     `anthropic-to-responses.ts`/`-stream.ts`). A server tool with NO mapping entry (or a
 *     client-executed builtin misclassified as one) still STRIPS + WARNS, same graceful-degradation
 *     discipline as before.
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
  ResponsesTool,
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

/**
 * Anthropic `tool_use` block → Responses `function_call` input item (arguments = JSON.stringify(input)).
 *
 * NO item `id`: a Responses `function_call` INPUT item is matched to its `function_call_output` by
 * `call_id` only. The item `id` is an OUTPUT-echo field the API validates as `fc_`-prefixed when present —
 * and we only ever hold the tool-call id (`call_`/`toolu_`) on this return leg (the forward leg maps a
 * Responses `call_id` → Anthropic `tool_use.id`, discarding the original `fc_` id). Emitting the tool-call
 * id as the item `id` produces a non-`fc` id that upstream rejects (400 `Expected an ID that begins with
 * 'fc'`); it is never needed for round-tripping (docs/spec/anthropic-via-openai-translation-review WARN-D).
 */
function toolUseToFunctionCall(block: ToolUseBlockParam): ResponsesInputItem {
  return { type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }
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
 * Server-tool name-gap mapping table (RFC §5.1, Phase 6): Anthropic's true SERVER-EXECUTED tools
 * (ADR 2026-07-13-server-tool-positioning-and-web-search-retirement §Part-1 — `web_search`/`web_fetch`/
 * `code_execution`, which the Anthropic API executes server-side and returns via `server_tool_use` +
 * `*_tool_result`; NOT the CLIENT-executed `memory`/`computer`/`text_editor`/`bash` builtins that share
 * the same API-defined-type-prefix convention but are executed by the CLIENT) → their Responses builtin
 * counterpart. Keyed on the Anthropic tool's TYPE PREFIX (Anthropic types carry a dated suffix, e.g.
 * `web_search_20250305` — the prefix is the stable match key, mirrors `isApiDefinedToolType`'s own
 * prefix-matching convention). A tool whose prefix has NO entry here (unmapped OR a client-executed
 * builtin misclassified by `isApiDefinedToolType`) falls through to the strip+warn degradation path —
 * this table is a GENERIC extension point, not a `web_search` special case (learn-by-analogy: adding a
 * new true server tool's Responses counterpart is one more table row, no new branch).
 *
 * Probe (c) (`exp/anthropic-responses-direct/FINDINGS.md`) confirmed the request-side leg of this
 * mapping is genuinely lossless: `/responses` accepted `tools:[{type:"web_search"}]` and the upstream
 * executed the search NATIVELY (no proxy impersonation) — the response-side result rendering is a
 * SEPARATE, asymmetric concern (§5.1/R-NO-REVIVE: always degrades, never round-trips — see
 * `anthropic-to-responses.ts`/`-stream.ts`).
 */
const SERVER_TOOL_MAPPING: ReadonlyArray<{ anthropicPrefix: string; responsesType: ResponsesBuiltinToolType }> = [
  // Anthropic's Responses-facing web_search request is a bare `{type:"web_search"}` (Phase 0 probe (c) —
  // NOT the richer `web_search_preview`/schema-carrying shape some OpenAI docs describe elsewhere; the
  // GHC Responses upstream accepted the bare form and returned real results).
  { anthropicPrefix: "web_search_", responsesType: "web_search" },
  // web_fetch / code_execution have NO probed Responses-upstream request shape yet (Phase 0 only probed
  // web_search) — omitted from the table until probed, rather than guessed. Falls through to strip+warn.
]

/** The Responses builtin-tool `type` values this table may emit (a subset of `ResponsesBuiltinTool["type"]`). */
type ResponsesBuiltinToolType = "web_search"

/** Look up the Responses builtin-tool mapping for an Anthropic tool's `type`, or undefined if unmapped. */
function mapServerToolType(anthropicType: string): ResponsesBuiltinToolType | undefined {
  return SERVER_TOOL_MAPPING.find((entry) => anthropicType.startsWith(entry.anthropicPrefix))?.responsesType
}

/**
 * Anthropic `tools[]` → Responses tools (function + native server-tool passthrough, RFC §5.1/Phase 6).
 * A true server-executed Anthropic tool (`isApiDefinedToolType`) with a {@link SERVER_TOOL_MAPPING}
 * entry passes through as the mapped Responses builtin tool (letting the Responses upstream execute it
 * natively); one with NO entry (unmapped type, or a client-executed builtin sharing the type-prefix
 * convention) is STRIPPED + WARNED — the same graceful-degradation discipline the CC leg still uses
 * (this bridge's request-side improvement is scoped to the mapped set, not a blanket passthrough).
 */
function translateTools(tools: Array<AnthropicTool>, reqId: string | undefined): Array<ResponsesTool> {
  const out: Array<ResponsesTool> = []
  for (const tool of tools) {
    if (isApiDefinedToolType(tool.type)) {
      const mapped = tool.type ? mapServerToolType(tool.type) : undefined
      if (mapped) {
        out.push({ type: mapped })
      } else {
        dropWarn(`dropping native server tool "${tool.name}" (type: ${tool.type}) — no Responses-builtin mapping (unmapped type or a client-executed builtin)`, reqId)
      }
      continue
    }
    out.push({
      type: "function",
      name: tool.name,
      ...(tool.description !== undefined && { description: tool.description }),
      ...(tool.input_schema !== undefined && { parameters: tool.input_schema }),
    } satisfies ResponsesFunctionTool)
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
