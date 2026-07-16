/**
 * Reverse translation: Responses request → Anthropic Messages request.
 *
 * RFC 2026-07-14-anthropic-responses-direct-bridge §3/§4.2 — the `(openai-responses client, /v1/messages)`
 * REVERSE request leg, replacing the two-hop `responses→cc→anthropic` translation with a single direct
 * fold of Responses `input[]` straight into Anthropic `MessageParam[]`.
 *
 * Direction (the mirror of `responses-to-anthropic.ts`, the forward-leg response translator):
 *   client Responses payload ─► translateResponsesToAnthropicRequest ─► upstream Anthropic Messages payload
 *
 * ⚠️ FOLD, not split (phase-2-audit §③ "须重新推导" — a NEW finding beyond the RFC's original scope):
 * Responses' `input[]` is FLAT — one item per message/function_call/function_call_output, unlike
 * Anthropic's one-turn-one-MessageParam model where a turn's text + tool_use (or text + tool_result)
 * live in a SINGLE `content[]` array. The existing `responses-to-cc-request.ts:translateInputItemToMessages`
 * (Responses→CC leg) does NOT fold — it emits one CC message per item, which is fine for CC (CC has no
 * strict one-turn-one-message rule the way Anthropic does) but would be WRONG here: Anthropic requires
 * assistant turns and user/tool-result turns each collapse into one MessageParam, or a client like Claude
 * Code reading back multiple adjacent same-role messages sees a malformed/fragmented conversation. This
 * file is a FRESH accumulate-then-flush state machine (modeled on `cc-to-anthropic-request.ts:76-92`'s
 * `pendingToolResults`/`flushToolResults` pattern — same SHAPE of solution, but keyed on RESPONSES item
 * types, not CC roles — NOT extracted/reused code, a parallel implementation per R-NO-INTERNAL-ADAPT).
 *
 * Fold rules (mirrors Anthropic's own turn model, spec §1.4):
 *   - Consecutive `function_call` items (all fired by the SAME assistant turn) fold into ONE assistant
 *     MessageParam's `content[]` as `tool_use` blocks (in order); an assistant `message` item's text
 *     folds into the SAME MessageParam's content BEFORE its tool_use blocks (Anthropic requires text
 *     before tool_use within one turn's content array — mirrors the forward leg's same-turn ordering).
 *   - Consecutive `function_call_output` items fold into ONE user MessageParam's `content[]` as
 *     `tool_result` blocks (mirrors `cc-to-anthropic-request.ts`'s tool-result grouping for CC's
 *     `role:"tool"` messages — Responses' flat `function_call_output` items play the analogous role).
 *   - A `message` item (role user/assistant/system/developer) starts (or continues, same-role) its own
 *     turn; a role change (or an intervening function_call/function_call_output) flushes the pending turn.
 *
 * Reused (Phase 2/3 audit ①, cross-format primitives — physically imported, not re-derived):
 *   - `repairToolInput` (tool-input-repair.ts) — malformed `function_call.arguments` JSON repair cascade
 *     (mirrors `responses-to-anthropic.ts`'s `parseToolArguments`, this file's forward-leg sibling).
 *
 * ⚠️ WARN-E hard-constraint checklist (mirrors `cc-to-anthropic-request.ts`'s red lines, same physical gap):
 *   ① thinking is NEVER synthesized. Responses `reasoning` input items (a client echoing back a PRIOR
 *      Responses reasoning item) have no verified-safe Anthropic mapping yet (round-trip is Phase 5,
 *      R-DIRECTION-ASYMMETRY — this leg does not yet forge/forward a signed thinking block); dropped here,
 *      NOT synthesized into an unsigned thinking block (which would hit GHC's "thinking blocks cannot be
 *      modified" 400 / poison the conversation, same red line as the CC reverse leg).
 *   ② tool_use.id: the Responses `call_id` is passed through verbatim as Anthropic `tool_use.id` (Responses
 *      IDs are `call_*`-prefixed by convention — inbound-acceptance by the Anthropic upstream is a
 *      Phase-5-adjacent probe, not yet verified here, same caveat `cc-to-anthropic-request.ts` records).
 *   ③ cache_control is NEVER injected (a Responses client cannot express Anthropic cache breakpoints).
 *   ④ native/custom server tools are stripped to function shape or dropped (Anthropic only accepts
 *      function tools on this leg — Responses `custom` tools degrade to a lossy-warned drop, `builtin`
 *      tools drop too; server-tool passthrough is Phase 6 scope, not this leg).
 */

import consola from "consola"

import type {
  //
  ContentBlockParam,
  ImageBlockParam,
  MessageParam,
  MessagesPayload,
  TextBlockParam,
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
  ResponsesOutputTextPart,
  ResponsesPayload,
  ResponsesToolChoice,
} from "~/types/api/openai-responses"

import { repairToolInput } from "~/lib/anthropic/tool-input-repair"

/**
 * Anthropic requires a positive `max_tokens`; Responses may omit it or send only `max_output_tokens`.
 * Mirrors `cc-to-anthropic-request.ts`'s DEFAULT_MAX_TOKENS fallback so the reverse wire is always
 * well-formed (the downstream Anthropic wire prep clamps it to the model window).
 */
const DEFAULT_MAX_TOKENS = 4096

/** The default repair cascade for a malformed `function_call.arguments` JSON string (mirrors the forward leg). */
const RESPONSE_TOOL_REPAIR_ITEMS = ["tags", "unicode", "jsonrepair"] as const

// ============================================================================
// Top-level request translation (Responses → Anthropic)
// ============================================================================

/**
 * Translate a Responses payload into an Anthropic Messages payload (REVERSE leg, direct bridge).
 *
 * Produces the logical Anthropic body only (the effectiveRequest track); the last-mile wire shaping
 * (sanitize / server-tool strip / thinking coercion / headers) stays in `prepareAnthropicRequest`
 * (mirrors `translateChatCompletionsToAnthropic`'s same division of concerns).
 */
export function translateResponsesToAnthropicRequest(payload: ResponsesPayload): MessagesPayload {
  const messages = foldInputItems(
    typeof payload.input === "string" ? [{ type: "message", role: "user", content: payload.input } satisfies ResponsesInputItem] : payload.input,
  )

  const tools = payload.tools ? translateTools(payload.tools) : undefined
  const toolChoice = payload.tool_choice ? translateToolChoice(payload.tool_choice) : undefined
  const system = payload.instructions ?? undefined

  // Intentional drops / NON-mappings (WARN-E + no Anthropic equivalent):
  //   NOTE: reasoning         — DROPPED (WARN-E ①: never synthesize thinking; round-trip is Phase 5)
  //   NOTE: cache_control     — NEVER injected (WARN-E ③, no Responses source for it anyway)
  //   NOTE: previous_response_id / store / metadata / truncation / context_management / text.verbosity
  //         — Responses-only, no Anthropic equivalent
  //   NOTE: service_tier / top_logprobs / parallel_tool_calls — Anthropic has no equivalent
  return {
    model: payload.model,
    max_tokens: payload.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    messages,
    ...(system !== undefined && system.length > 0 && { system }),
    ...(payload.temperature !== undefined && payload.temperature !== null && { temperature: payload.temperature }),
    ...(payload.top_p !== undefined && payload.top_p !== null && { top_p: payload.top_p }),
    ...(payload.stream !== undefined && payload.stream !== null && { stream: payload.stream }),
    ...(tools && tools.length > 0 && { tools }),
    ...(toolChoice !== undefined && { tool_choice: toolChoice }),
    ...(payload.user !== undefined && payload.user !== null && { metadata: { user_id: payload.user } }),
  }
}

// ============================================================================
// input[] → messages[] FOLD (accumulate-then-flush state machine, NOT extracted from any CC file)
// ============================================================================

/** Which Anthropic turn is currently being accumulated (or none). */
type PendingTurn =
  | { kind: "assistant"; textParts: Array<string>; toolUse: Array<ToolUseBlockParam> }
  | { kind: "tool-results"; blocks: Array<ToolResultBlockParam> }
  | { kind: "plain"; role: "user" | "system" | "developer"; content: string | Array<ContentBlockParam> }
  | undefined

/**
 * Fold Responses `input[]` (flat, one item per element) into Anthropic `MessageParam[]` (one array per
 * turn). Accumulates a pending turn across consecutive same-kind items; a kind change (or role change
 * within `message` items) flushes the pending turn first — mirrors the shape of
 * `cc-to-anthropic-request.ts`'s `pendingToolResults`/`flushToolResults`, but this is a THREE-way fold
 * (assistant text+tool_use / user tool_result / plain message), not the CC leg's two-way one (tool vs
 * everything-else), because Responses splits assistant text and tool_use into SEPARATE flat items where
 * CC keeps them on one message already.
 */
function foldInputItems(items: ReadonlyArray<ResponsesInputItem>): Array<MessageParam> {
  const messages: Array<MessageParam> = []
  let pending: PendingTurn

  const flush = (): void => {
    if (pending === undefined) return
    switch (pending.kind) {
      case "assistant": {
        const blocks: Array<ContentBlockParam> = []
        const text = pending.textParts.join("")
        if (text.length > 0) blocks.push({ type: "text", text } satisfies TextBlockParam)
        blocks.push(...pending.toolUse)
        if (blocks.length > 0) messages.push({ role: "assistant", content: blocks })

        break
      }
      case "tool-results": {
        if (pending.blocks.length > 0) messages.push({ role: "user", content: pending.blocks })

        break
      }
      case "plain": {
        // W3 guard (mirrors cc-to-anthropic-request.ts's translateUserMessage): an empty-content turn
        // would be an Anthropic 400 (content:[] / content:"") — skip it, never emit a well-formed-looking
        // empty turn.
        const isEmpty = typeof pending.content === "string" ? pending.content.length === 0 : pending.content.length === 0
        if (!isEmpty) messages.push({ role: pending.role === "developer" ? "user" : pending.role, content: pending.content })

        break
      }
      // No default
    }
    pending = undefined
  }

  for (const item of items) {
    const type = item.type ?? "message"

    if (type === "function_call") {
      if (pending?.kind !== "assistant") {
        flush()
        pending = { kind: "assistant", textParts: [], toolUse: [] }
      }
      pending.toolUse.push(functionCallToToolUseBlock(item))
      continue
    }

    if (type === "function_call_output") {
      if (pending?.kind !== "tool-results") {
        flush()
        pending = { kind: "tool-results", blocks: [] }
      }
      const block = functionCallOutputToToolResultBlock(item)
      if (block) pending.blocks.push(block)
      continue
    }

    if (type === "reasoning" || type === "item_reference") {
      // No verified-safe Anthropic mapping yet (WARN-E ①, R-DIRECTION-ASYMMETRY — round-trip is Phase 5)
      // — drop, do not flush the current turn (a reasoning echo does not itself start a new turn).
      continue
    }

    // "message" (or any other/future type) — a plain user/assistant/system/developer turn.
    const role = item.role ?? "user"
    if (role === "system" || role === "developer") {
      // system/developer messages fold into the top-level `system` field by the caller's convention on
      // OTHER legs (anthropic-to-cc-request.ts's forward leg), but Responses input items can carry
      // system/developer messages MID-CONVERSATION (not just a leading instructions field) — Anthropic
      // has no mid-conversation system turn, so fold as a plain "user" turn (best-effort, never silently
      // dropped) rather than discard it (richest-data-flow).
      flush()
      const text = extractText(item.content)
      if (text.length > 0) messages.push({ role: "user", content: text })
      continue
    }

    if (pending?.kind === "assistant" && role === "assistant") {
      // A text-only message item CONTINUING the same assistant turn (arrives before or between
      // function_call items) — fold its text into the pending assistant turn instead of starting a new one.
      pending.textParts.push(extractText(item.content))
      continue
    }

    flush()
    if (role === "assistant") {
      pending = { kind: "assistant", textParts: [extractText(item.content)], toolUse: [] }
    } else {
      pending = { kind: "plain", role: "user", content: translateContentParts(item.content) }
    }
  }
  flush()

  return messages
}

/** Extract plain text from a Responses item's `content` (string, or array of text-bearing parts). */
function extractText(content: ResponsesInputItem["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if ("text" in part && typeof part.text === "string") return part.text
      return ""
    })
    .join("")
}

/** Translate a Responses `message` item's user-turn content into Anthropic content blocks (or a plain string). */
function translateContentParts(content: ResponsesInputItem["content"]): string | Array<ContentBlockParam> {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const blocks: Array<ContentBlockParam> = []
  for (const part of content) {
    if (isTextPart(part) && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text } satisfies TextBlockParam)
      continue
    }
    if (part.type === "input_image" && typeof part.image_url === "string") {
      blocks.push(imageUrlToBlock(part.image_url))
      continue
    }
    // input_file has no clean Anthropic content-block equivalent — drop (mirrors the CC leg's same gap).
  }
  // Collapse a pure-text turn to a string (Anthropic-idiomatic; mirrors anthropic-to-cc-request.ts's
  // analogous collapse on the forward leg).
  if (blocks.length > 0 && blocks.every((b) => b.type === "text")) return blocks.map((b) => b.text).join("")
  return blocks
}

function isTextPart(
  part: ResponsesInputContentPart | ResponsesOutputTextPart,
): part is Extract<ResponsesInputContentPart | ResponsesOutputTextPart, { text: string }> {
  return part.type === "input_text" || part.type === "output_text"
}

// ============================================================================
// function_call / function_call_output → tool_use / tool_result
// ============================================================================

/** Responses `function_call` input item → Anthropic `tool_use` block (call_id passed through verbatim — WARN-E ②). */
function functionCallToToolUseBlock(item: ResponsesInputItem): ToolUseBlockParam {
  return { type: "tool_use", id: item.call_id ?? item.id ?? "", name: item.name ?? "", input: parseToolArguments(item.arguments ?? "") }
}

/**
 * Responses `function_call_output` input item → Anthropic `tool_result` block.
 *
 * W3 guard (mirrors `cc-to-anthropic-request.ts`'s `toolMessageToResultBlock`): a missing `call_id` would
 * produce `tool_use_id:""`, matching no assistant `tool_use` → GHC 400 — skip it (warned, never silent).
 */
function functionCallOutputToToolResultBlock(item: ResponsesInputItem): ToolResultBlockParam | undefined {
  const callId = item.call_id ?? item.id
  if (!callId) {
    consola.warn(
      `[Responses→Anthropic] dropping tool result with no call_id (would produce an unmatched empty tool_use_id → GHC 400): ${(item.output ?? "").slice(0, 120)}`,
    )
    return undefined
  }
  return { type: "tool_result", tool_use_id: callId, content: item.output ?? "" }
}

/** Parse a Responses `function_call.arguments` JSON string → Anthropic `input` object; malformed → repair cascade → `{}`. */
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
// Images
// ============================================================================

/** Responses `input_image.image_url` (data URL or http URL) → Anthropic `image` block. */
function imageUrlToBlock(url: string): ImageBlockParam {
  const parsed = parseDataUrl(url)
  if (parsed) {
    return {
      type: "image",
      source: { type: "base64", media_type: parsed.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: parsed.data },
    }
  }
  return { type: "image", source: { type: "url", url } }
}

/** Parse a `data:<mime>;base64,<data>` URL; returns undefined for a non-data (http) URL. */
function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  if (!url.startsWith("data:")) return undefined
  const commaIdx = url.indexOf(",")
  if (commaIdx === -1) return undefined
  const meta = url.slice(5, commaIdx)
  const data = url.slice(commaIdx + 1)
  const mediaType = meta.replace(/;base64$/i, "")
  return { mediaType, data }
}

// ============================================================================
// Tools / tool_choice
// ============================================================================

/**
 * Responses `tools[]` → Anthropic function tools. Only `function` tools carry over (WARN-E ④): `custom`
 * (freeform) tools degrade with a warning (no Anthropic freeform-tool equivalent), `builtin` server tools
 * drop with a warning (server-tool passthrough is Phase 6 scope).
 */
function translateTools(tools: ReadonlyArray<{ type: string; name?: string }>): Array<AnthropicTool> {
  const out: Array<AnthropicTool> = []
  for (const tool of tools) {
    if (tool.type !== "function") {
      consola.warn(`[Responses→Anthropic] dropping non-function tool "${tool.name ?? "unknown"}" (type: ${tool.type}) — unsupported on the Anthropic leg`)
      continue
    }
    const fn = tool as ResponsesFunctionTool
    out.push({
      name: fn.name,
      ...(fn.description !== undefined && { description: fn.description }),
      ...(fn.parameters !== undefined && { input_schema: fn.parameters }),
    })
  }
  return out
}

/** Responses `tool_choice` → Anthropic `tool_choice` (mirrors the forward leg's same vocabulary, inverted). */
function translateToolChoice(choice: ResponsesToolChoice): AnthropicToolChoice {
  if (typeof choice === "string") {
    switch (choice) {
      case "auto": {
        return { type: "auto" }
      }
      case "required": {
        return { type: "any" }
      }
      default: {
        // "none"
        return { type: "none" }
      }
    }
  }
  return { type: "tool", name: choice.name }
}
