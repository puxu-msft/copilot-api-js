/**
 * Reverse translation: Chat Completions request → Anthropic Messages request.
 *
 * The REVERSE request leg of the translation matrix (RFC 2026-07-11-anthropic-via-openai-translation
 * §9 / §11): a CC / Responses / Gemini client (whose body reaches here already normalized to CC —
 * Gemini via `convertGeminiRequestToOpenAI`, Responses via `translateResponsesToChatCompletions`)
 * pinned to `@messages` reaches a direct-Anthropic upstream leg. This turns the CC body into an
 * Anthropic Messages payload the Anthropic wire prep (`prepareAnthropicRequest`) consumes.
 *
 * Direction (the mirror of `anthropic-to-cc-request.ts`, the forward leg):
 *   client CC payload ─► translateChatCompletionsToAnthropic ─► upstream Anthropic Messages payload
 *
 * ⚠️ WARN-E hard-constraint checklist (RFC §9, spec §8, skill `ghc-anthropic-upstream`):
 *   ① thinking is NEVER synthesized. A CC request carries no thinking; the reverse leg must NOT
 *      fabricate an Anthropic `thinking` content block — an unsigned thinking block hits GHC's
 *      "messages.N: thinking blocks cannot be modified" 400 / poisons the conversation. Client
 *      reasoning intent (`reasoning_effort`) is DROPPED here, NOT mapped into a thinking block (and
 *      deliberately not into a `thinking` config either — keeping the reverse leg free of any
 *      thinking synthesis is the bright-line boundary; a future config mapping would need its own
 *      poisoning audit). The red-line unit test asserts the output contains ZERO thinking blocks.
 *   ② tool_use.id: the CC `tool_call.id` is passed through verbatim as the Anthropic `tool_use.id`
 *      (PROBE OQ3 confirmed the OUTBOUND direction only: GHC's cc leg RETURNS `toolu_*`, the responses
 *      leg RETURNS `call_*`). Verbatim pass-through is the only sane choice regardless, but whether
 *      GHC's Anthropic leg ACCEPTS a `call_*` id on an INBOUND request tool id is NOT yet probed —
 *      the reverse leg does not reach the upstream until Phase 5, so this is a Phase-5 gate: probe
 *      inbound acceptance before wiring, do NOT inherit this as verified fact (verifying-authoritative-claims).
 *   ③ cache_control is NEVER injected (a CC client cannot express Anthropic cache breakpoints).
 *   ④ native server tools are stripped (CC has only function tools; any non-function tool is dropped).
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
  ChatCompletionsPayload,
  ContentPart,
  Message,
  ToolCall,
} from "~/types/api/openai-chat-completions"

/**
 * Anthropic requires a positive `max_tokens`; CC may omit it (or send `max_completion_tokens`). When
 * neither is present we fall back to this so the reverse wire is always well-formed (the downstream
 * Anthropic wire prep clamps it to the model window).
 */
const DEFAULT_MAX_TOKENS = 4096

// ============================================================================
// Top-level request translation (CC → Anthropic)
// ============================================================================

/**
 * Translate a Chat Completions payload into an Anthropic Messages payload (reverse leg).
 *
 * Produces the logical Anthropic body only (the effectiveRequest track); the last-mile wire shaping
 * (sanitize / server-tool strip / thinking coercion / headers) stays in `prepareAnthropicRequest`.
 */
export function translateChatCompletionsToAnthropic(payload: ChatCompletionsPayload): MessagesPayload {
  const systemParts: Array<string> = []
  const messages: Array<MessageParam> = []

  // Group consecutive `role:"tool"` messages into a single user turn of tool_result blocks (Anthropic
  // requires tool results as a user message; adjacent CC tool messages collapse into one).
  let pendingToolResults: Array<ToolResultBlockParam> = []
  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return
    messages.push({ role: "user", content: pendingToolResults })
    pendingToolResults = []
  }

  for (const message of payload.messages) {
    if (message.role === "tool") {
      // W3 guard: a tool message with no `tool_call_id` would produce `tool_use_id:""`, which
      // matches no assistant tool_use and hits GHC's Anthropic 400 — skip it (warned, never a
      // silent empty string). See toolMessageToResultBlock.
      const block = toolMessageToResultBlock(message)
      if (block) pendingToolResults.push(block)
      continue
    }
    flushToolResults()

    switch (message.role) {
      case "system":
      case "developer": {
        const text = ccContentToText(message.content)
        if (text.length > 0) systemParts.push(text)
        break
      }
      case "assistant": {
        const block = translateAssistantMessage(message)
        if (block) messages.push(block)
        break
      }
      default: {
        // user — W3 guard: an empty-content user turn (empty array OR empty string) would produce
        // `content:[]` / `content:""`, an Anthropic 400; skip it (symmetric with the forward
        // `translateUserBlocks` `userParts.length > 0` guard). See translateUserMessage.
        const userMessage = translateUserMessage(message)
        if (userMessage) messages.push(userMessage)
        break
      }
    }
  }
  flushToolResults()

  const tools = payload.tools ? translateTools(payload.tools) : undefined
  const toolChoice = payload.tool_choice ? translateToolChoice(payload.tool_choice) : undefined
  const stopSequences = normalizeStop(payload.stop)

  // Intentional drops / NON-mappings (WARN-E + no CC equivalent):
  //   NOTE: reasoning_effort — DROPPED (WARN-E ①: never synthesize thinking; no thinking config either)
  //   NOTE: cache_control    — NEVER injected (WARN-E ③)
  //   NOTE: n / logprobs / seed / response_format / frequency_penalty / presence_penalty / logit_bias
  //         / service_tier / parallel_tool_calls — Anthropic has no equivalent
  return {
    model: payload.model,
    max_tokens: payload.max_tokens ?? payload.max_completion_tokens ?? DEFAULT_MAX_TOKENS,
    messages,
    ...(systemParts.length > 0 && { system: systemParts.join("\n\n") }),
    ...(payload.temperature !== undefined && payload.temperature !== null && { temperature: payload.temperature }),
    ...(payload.top_p !== undefined && payload.top_p !== null && { top_p: payload.top_p }),
    ...(payload.stream !== undefined && payload.stream !== null && { stream: payload.stream }),
    ...(stopSequences !== undefined && { stop_sequences: stopSequences }),
    ...(tools && tools.length > 0 && { tools }),
    ...(toolChoice !== undefined && { tool_choice: toolChoice }),
    ...(payload.user !== undefined && payload.user !== null && { metadata: { user_id: payload.user } }),
  }
}

// ============================================================================
// Messages
// ============================================================================

/**
 * CC `role:"tool"` message → Anthropic `tool_result` block (tool_call_id passed through — WARN-E ②).
 *
 * W3 guard: returns undefined when `tool_call_id` is missing/empty. An empty `tool_use_id` matches no
 * assistant `tool_use` on the Anthropic wire → GHC 400; dropping the orphan result (warned) is the
 * only well-formed choice (a recognizable placeholder would ALSO fail to match — never-swallow).
 */
function toolMessageToResultBlock(message: Message): ToolResultBlockParam | undefined {
  if (!message.tool_call_id) {
    consola.warn(
      `[CC→Anthropic] dropping tool result with no tool_call_id (would produce an unmatched empty tool_use_id → GHC 400): ${ccContentToText(message.content).slice(0, 120)}`,
    )
    return undefined
  }
  return {
    type: "tool_result",
    tool_use_id: message.tool_call_id,
    content: ccContentToText(message.content),
  }
}

/**
 * CC user message → Anthropic user message (text/image blocks; string stays a string).
 *
 * W3 guard: returns undefined for an EMPTY user turn (empty content array OR empty string). An empty
 * `content` is an Anthropic 400; skipping it mirrors the forward `translateUserBlocks` guard
 * (`userParts.length > 0`).
 */
function translateUserMessage(message: Message): MessageParam | undefined {
  if (typeof message.content === "string") {
    return message.content.length > 0 ? { role: "user", content: message.content } : undefined
  }
  const blocks: Array<ContentBlockParam> = []
  for (const part of message.content ?? []) {
    // ContentPart is a closed `text | image_url` union — text → text block, else → image block.
    if (part.type === "text") blocks.push({ type: "text", text: part.text })
    else blocks.push(imagePartToBlock(part))
  }
  if (blocks.length === 0) return undefined
  return { role: "user", content: blocks }
}

/**
 * CC assistant message → Anthropic assistant message. Folds text content + tool_calls into content
 * blocks (text block(s) then tool_use blocks). Returns undefined for an empty turn (no text, no calls).
 */
function translateAssistantMessage(message: Message): MessageParam | undefined {
  const blocks: Array<ContentBlockParam> = []

  const text = ccContentToText(message.content)
  if (text.length > 0) blocks.push({ type: "text", text } satisfies TextBlockParam)

  if (message.tool_calls) {
    for (const call of message.tool_calls) blocks.push(toolCallToUseBlock(call))
  }

  if (blocks.length === 0) return undefined
  return { role: "assistant", content: blocks }
}

/** CC `tool_calls[]` entry → Anthropic `tool_use` block (arguments JSON.parse → input; id passed through). */
function toolCallToUseBlock(call: ToolCall): ToolUseBlockParam {
  return {
    type: "tool_use",
    id: call.id,
    name: call.function.name,
    input: parseToolArguments(call.function.arguments),
  }
}

/** Parse a CC tool-call `arguments` JSON string → Anthropic `input` object; malformed → `{}` (warned, never throw). */
function parseToolArguments(args: string): unknown {
  if (!args) return {}
  try {
    return JSON.parse(args)
  } catch {
    consola.warn(`[CC→Anthropic] tool_call arguments not valid JSON — passing empty input: ${args.slice(0, 120)}`)
    return {}
  }
}

/** CC `image_url` content part → Anthropic `image` block (data URL → base64 source, else url source). */
function imagePartToBlock(part: Extract<ContentPart, { type: "image_url" }>): ImageBlockParam {
  const url = part.image_url.url
  const parsed = parseDataUrl(url)
  if (parsed) {
    return { type: "image", source: { type: "base64", media_type: parsed.mediaType as ImageBase64Media, data: parsed.data } }
  }
  return { type: "image", source: { type: "url", url } }
}

/** The base64 image media types the Anthropic SDK's `Base64ImageSource` accepts. */
type ImageBase64Media = "image/jpeg" | "image/png" | "image/gif" | "image/webp"

/** Parse a `data:<mime>;base64,<data>` URL; returns undefined for a non-data (http) URL. */
function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  if (!url.startsWith("data:")) return undefined
  const commaIdx = url.indexOf(",")
  if (commaIdx === -1) return undefined
  const meta = url.slice(5, commaIdx) // between "data:" and ","
  const data = url.slice(commaIdx + 1)
  const mediaType = meta.replace(/;base64$/i, "")
  return { mediaType, data }
}

/** Flatten a CC message `content` (string | ContentPart[] | null) to plain text (concatenate text parts). */
function ccContentToText(content: Message["content"]): string {
  if (content === null) return ""
  if (typeof content === "string") return content
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
}

// ============================================================================
// Tools / tool_choice / stop
// ============================================================================

/**
 * CC function tools → Anthropic tools. Only `function` tools are carried (WARN-E ④: any non-function
 * tool is a server/builtin artifact and is dropped); `cache_control` is NEVER injected (WARN-E ③).
 */
function translateTools(tools: NonNullable<ChatCompletionsPayload["tools"]>): Array<AnthropicTool> {
  const out: Array<AnthropicTool> = []
  for (const tool of tools) {
    // CC's `Tool` type is function-only, but a raw wire payload may carry other tool types — check
    // defensively (WARN-E ④) and drop anything non-function.
    if ((tool as { type?: unknown }).type !== "function") {
      consola.warn(`[CC→Anthropic] dropping non-function tool (type: ${String((tool as { type?: unknown }).type)}) — unsupported on the Anthropic leg`)
      continue
    }
    out.push({
      name: tool.function.name,
      ...(tool.function.description !== undefined && { description: tool.function.description }),
      ...(tool.function.parameters !== undefined && { input_schema: tool.function.parameters }),
    })
  }
  return out
}

/** CC `tool_choice` → Anthropic `tool_choice`. */
function translateToolChoice(choice: NonNullable<ChatCompletionsPayload["tool_choice"]>): AnthropicToolChoice {
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
  return { type: "tool", name: choice.function.name }
}

/** CC `stop` (string | string[] | null) → Anthropic `stop_sequences` (string[] | undefined). */
function normalizeStop(stop: ChatCompletionsPayload["stop"]): Array<string> | undefined {
  if (stop === undefined || stop === null) return undefined
  const arr = typeof stop === "string" ? [stop] : stop
  return arr.length > 0 ? arr : undefined
}
