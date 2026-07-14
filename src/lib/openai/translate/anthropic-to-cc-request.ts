/**
 * Inbound translation: Anthropic Messages request → Chat Completions request.
 *
 * The FORWARD request leg of the translation matrix (RFC 2026-07-11-anthropic-via-openai-translation
 * §9, spec §6): an Anthropic `/v1/messages` client whose model is pinned to `@cc`/`@responses`
 * (or remapped to a non-direct model) reaches the upstream through the OpenAI protocol leg. This
 * module turns the Anthropic-shaped body into a CC payload the openai-cc wire prep (and, via
 * `translateChatCompletionsToResponses`, the Responses leg) consumes.
 *
 * Direction (the mirror of `cc-to-anthropic-request.ts`, the reverse leg):
 *   client Anthropic payload ─► translateAnthropicToChatCompletions ─► upstream CC payload
 *
 * Modelled on `responses-to-cc-request.ts` (the Responses→CC forward leg) — same "walk the
 * inbound content, degrade format-specific constructs, never silently drop" discipline.
 *
 * Graceful degradation (spec §1.4 / §8, "尽力而为"):
 *   - `thinking` → `reasoning_effort` when the resolved model supports it (budget→tier heuristic,
 *     OQ2); dropped otherwise (non-reasoning models ignore the field anyway).
 *   - `cache_control` breakpoints (on system / blocks / tools) → STRIPPED (CC has no equivalent).
 *   - native server tools (`web_search`, `code_execution`, …) → STRIPPED, warned (never silent).
 *   - `thinking`/`redacted_thinking` assistant blocks → dropped (CC carries no thinking; the FORWARD
 *     drop is benign — the REVERSE red line against SYNTHESIZING thinking lives in
 *     `cc-to-anthropic-request.ts`).
 *   - `top_k` → dropped (no CC equivalent).
 *
 * Multi-choices fold (PROBE-FINDINGS): GHC's cc leg splits an assistant turn's text + tool_use into
 * SEPARATE response `choices`. The request side is the symmetric FOLD — an assistant turn's text and
 * tool_use blocks collapse into ONE CC assistant message (`content` + `tool_calls` coexist, which CC
 * permits), so a downstream round-trip is well-formed.
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
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool as CCTool,
  ToolCall,
} from "~/types/api/openai-chat-completions"

import { isApiDefinedToolType } from "~/lib/anthropic/message-tools"
import { budgetToEffort } from "~/lib/anthropic/thinking-coercion"

/** Options for {@link translateAnthropicToChatCompletions}. */
export interface AnthropicToCcOptions {
  /**
   * The resolved upstream model. Used ONLY to gate the `thinking` → `reasoning_effort` mapping on
   * `supports.reasoning_effort` (spec §6). When omitted (pure unit tests), the effort is mapped
   * best-effort without the capability gate — upstream ignores `reasoning_effort` for non-reasoning
   * models anyway, so an over-eager map is harmless.
   */
  model?: Model
  /**
   * The originating request id (`ctx.id`), threaded purely to TAG the `[Anthropic→CC]` lossy-drop
   * warnings (native server tools / server_tool_use / tool_result images that have no CC equivalent)
   * so a warning in the logs can be correlated to its request. Omitted in pure unit tests — the drop
   * warnings then carry no `requestId=` suffix.
   */
  reqId?: string
}

// ============================================================================
// Top-level request translation (Anthropic → CC)
// ============================================================================

/**
 * Emit an `[Anthropic→CC]` lossy-drop warning, tagged with `requestId=<reqId>` when the originating
 * request id is known (threaded from `opts.reqId`) so a drop in the logs is traceable to its request.
 */
function ccDropWarn(message: string, reqId: string | undefined): void {
  consola.warn(`[Anthropic→CC] ${message}${reqId ? ` requestId=${reqId}` : ""}`)
}

/**
 * Translate an Anthropic Messages payload into a Chat Completions payload.
 *
 * The upstream endpoint's last-mile shaping (max_completion_tokens fill for gpt-5.x, header build)
 * stays in `prepareChatCompletionsRequest`/`prepareResponsesRequest` — this produces the logical
 * CC body only (the effectiveRequest track).
 */
export function translateAnthropicToChatCompletions(payload: MessagesPayload, opts?: AnthropicToCcOptions): ChatCompletionsPayload {
  const reqId = opts?.reqId
  const messages: Array<Message> = []

  // 1. Top-level `system` (string OR TextBlockParam[]) → leading CC system message.
  const systemText = anthropicSystemToText(payload.system)
  if (systemText.length > 0) messages.push({ role: "system", content: systemText })

  // 2. Conversation turns → CC messages (tool_result blocks split into their own role:tool messages).
  for (const message of payload.messages) messages.push(...translateMessage(message, reqId))

  const tools = payload.tools ? translateTools(payload.tools, reqId) : undefined
  const toolChoice = payload.tool_choice ? translateToolChoice(payload.tool_choice) : undefined
  const reasoningEffort = translateThinkingToEffort(payload, opts?.model)
  const stop = normalizeStopSequences(payload.stop_sequences)

  // 3. Assemble. Intentional drops (Anthropic-only, no CC equivalent):
  //   NOTE: payload.top_k             — CC has no top_k
  //   NOTE: payload.cache_control     — stripped at the block/tool level (see translate* helpers)
  //   NOTE: payload.context_management — Anthropic/GHC-only compaction config
  //   NOTE: payload.output_config     — Anthropic structured-outputs / adaptive-effort (effort folded
  //                                     into reasoning_effort above; format has no CC mirror)
  return {
    model: payload.model,
    messages,
    max_tokens: payload.max_tokens,
    ...(payload.temperature !== undefined && { temperature: payload.temperature }),
    ...(payload.top_p !== undefined && { top_p: payload.top_p }),
    ...(payload.stream !== undefined && { stream: payload.stream }),
    ...(stop !== undefined && { stop }),
    ...(reasoningEffort !== undefined && { reasoning_effort: reasoningEffort }),
    ...(tools && tools.length > 0 && { tools }),
    ...(toolChoice !== undefined && { tool_choice: toolChoice }),
    ...(payload.metadata?.user_id !== undefined && { user: payload.metadata.user_id }),
  }
}

// ============================================================================
// System prompt
// ============================================================================

/** Flatten Anthropic `system` (string OR TextBlockParam[]) to a plain string, dropping cache_control. */
function anthropicSystemToText(system: MessagesPayload["system"]): string {
  if (system === undefined) return ""
  if (typeof system === "string") return system
  // The array form is TextBlockParam[] (only text blocks) — concatenate the text, drop cache_control.
  return system.map((block) => block.text).join("")
}

// ============================================================================
// Messages / content blocks
// ============================================================================

/**
 * Translate one Anthropic message into 0+ CC messages.
 *
 * A user turn's `tool_result` blocks each become their OWN `role:"tool"` message (CC requires tool
 * results as separate messages, following the assistant's tool_calls). Remaining user text/image
 * blocks fold into one `role:"user"` message. An assistant turn's text + tool_use blocks fold into
 * one `role:"assistant"` message (`content` + `tool_calls` — the multi-choices request-side fold).
 */
function translateMessage(message: MessageParam, reqId: string | undefined): Array<Message> {
  const role = message.role

  // String content → passthrough (no blocks to walk).
  if (typeof message.content === "string") {
    return [{ role, content: message.content }]
  }

  const blocks = message.content

  if (role === "assistant") {
    return translateAssistantBlocks(blocks, reqId)
  }

  // user (also the container for tool_result responses to a prior assistant turn).
  return translateUserBlocks(blocks, reqId)
}

/** Assistant turn: fold text + tool_use into one CC assistant message; drop thinking / server_tool_use. */
function translateAssistantBlocks(blocks: Array<ContentBlockParam>, reqId: string | undefined): Array<Message> {
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
        // CC has no thinking channel — drop (the forward direction only; the reverse leg's
        // red line against SYNTHESIZING thinking lives in cc-to-anthropic-request.ts).
        break
      }
      case "server_tool_use": {
        ccDropWarn(`dropping server_tool_use block "${(block as { name?: string }).name ?? "unknown"}" (no CC equivalent)`, reqId)
        break
      }
      default: {
        // Other server-tool artifacts (*_tool_result on an assistant turn are non-standard) — drop.
        break
      }
    }
  }

  const text = textParts.join("")
  const message: Message = {
    role: "assistant",
    // content + tool_calls coexist in CC. content:null when the turn is tool-only (CC convention).
    content: text.length > 0 ? text : null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  }
  return [message]
}

/**
 * User turn: emit each `tool_result` as its own `role:"tool"` message (in block order), then fold
 * remaining text/image blocks into one `role:"user"` message. Server-tool result blocks are dropped.
 */
function translateUserBlocks(blocks: Array<ContentBlockParam>, reqId: string | undefined): Array<Message> {
  const out: Array<Message> = []
  const userParts: Array<ContentPart> = []

  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        userParts.push({ type: "text", text: block.text })
        break
      }
      case "image": {
        userParts.push(imageBlockToContentPart(block))
        break
      }
      case "tool_result": {
        out.push(toolResultToMessage(block, reqId))
        break
      }
      default: {
        // thinking/redacted_thinking on a user turn is non-standard; server_tool_result blocks are
        // server-side artifacts. Drop either way (no CC equivalent).
        break
      }
    }
  }

  if (userParts.length > 0) {
    // Collapse a pure-text user message to a string (CC-idiomatic; avoids a needless part array).
    const onlyText = userParts.every((p) => p.type === "text")
    const content: Message["content"] = onlyText ? userParts.map((p) => (p as { text: string }).text).join("") : userParts
    out.push({ role: "user", content })
  }

  return out
}

/** Anthropic `tool_use` block → CC `tool_calls[]` entry (arguments = JSON.stringify(input)). */
function toolUseToToolCall(block: ToolUseBlockParam): ToolCall {
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input ?? {}),
    },
  }
}

/**
 * Anthropic `tool_result` block → CC `role:"tool"` message.
 *
 * `content` may be a string OR an array of blocks (text / image). CC tool messages carry a string,
 * so text blocks are concatenated; images inside a tool_result have no clean CC tool-message slot
 * and are dropped (rare — warned). An `is_error` result is prefixed so the model still sees it failed.
 */
function toolResultToMessage(block: ToolResultBlockParam, reqId: string | undefined): Message {
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
    if (droppedImages > 0) ccDropWarn(`tool_result ${block.tool_use_id}: dropped ${droppedImages} image block(s) (no CC tool-message slot)`, reqId)
    text = textPieces.join("")
  } else {
    text = ""
  }

  return {
    role: "tool",
    tool_call_id: block.tool_use_id,
    content: block.is_error ? `[tool_error] ${text}` : text,
  }
}

/** Anthropic `image` block → CC `image_url` content part (base64 → data URL, url → url). */
function imageBlockToContentPart(block: ImageBlockParam): ContentPart {
  const source = block.source
  if (source.type === "base64") {
    return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } }
  }
  // URLImageSource
  return { type: "image_url", image_url: { url: source.url } }
}

// ============================================================================
// Tools / tool_choice
// ============================================================================

/**
 * Anthropic `tools[]` → CC function tools. Native server tools (`web_search`, `code_execution`, …,
 * identified by their `type` prefix) are STRIPPED (warned); `cache_control` is not copied.
 */
function translateTools(tools: Array<AnthropicTool>, reqId: string | undefined): Array<CCTool> {
  const out: Array<CCTool> = []
  for (const tool of tools) {
    if (isApiDefinedToolType(tool.type)) {
      ccDropWarn(`dropping native server tool "${tool.name}" (type: ${tool.type}) — unsupported on the CC leg`, reqId)
      continue
    }
    out.push({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description !== undefined && { description: tool.description }),
        ...(tool.input_schema !== undefined && { parameters: tool.input_schema }),
      },
    })
  }
  return out
}

/** Anthropic `tool_choice` → CC `tool_choice`. */
function translateToolChoice(choice: AnthropicToolChoice): NonNullable<ChatCompletionsPayload["tool_choice"]> {
  switch (choice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      // Anthropic "any" = must call SOME tool → CC "required".
      return "required"
    }
    case "none": {
      return "none"
    }
    case "tool": {
      return { type: "function", function: { name: choice.name } }
    }
    default: {
      // Exhaustive over the ToolChoice union; a future variant falls back to "auto" (never silently
      // forces a tool the CC leg may not accept).
      return "auto"
    }
  }
}

// ============================================================================
// Thinking → reasoning_effort / stop_sequences
// ============================================================================

/**
 * Map Anthropic `thinking` → CC `reasoning_effort` (spec §6 / OQ2). `enabled{budget_tokens}` uses the
 * shared budget→tier heuristic; `adaptive` uses `output_config.effort`; `disabled`/absent → undefined.
 * Gated on the model's `supports.reasoning_effort` whitelist when a model is supplied.
 */
function translateThinkingToEffort(payload: MessagesPayload, model: Model | undefined): ChatCompletionsPayload["reasoning_effort"] {
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
  return effort
}

/** CC `reasoning_effort` accepts only low/medium/high — clamp/normalize any other effort string. */
function clampToCcEffort(effort: string | undefined): "low" | "medium" | "high" | undefined {
  if (effort === "low" || effort === "medium" || effort === "high") return effort
  if (effort === "none") return "low"
  if (effort === "xhigh" || effort === "max") return "high"
  return undefined
}

/** Does the model advertise a non-empty `reasoning_effort` capability array? */
function modelSupportsReasoningEffort(model: Model): boolean {
  const support = model.capabilities?.supports?.reasoning_effort
  return Array.isArray(support) && support.length > 0
}

/** Anthropic `stop_sequences` (array) → CC `stop` (string | string[] | undefined). */
function normalizeStopSequences(stop: Array<string> | undefined): string | Array<string> | undefined {
  if (stop === undefined || stop.length === 0) return undefined
  return stop
}
