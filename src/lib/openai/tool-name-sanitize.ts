/**
 * Per-model tool-name sanitization for the OpenAI paths (Chat Completions +
 * Responses).
 *
 * Builds a deterministic bidirectional name mapper from the client's tool
 * definitions and applies it to outbound requests (tool defs + tool-call names
 * in messages/input), restoring the client's original names on the response.
 *
 * The mapper is rebuilt per request and is stateless; response handlers read it
 * back from `RequestContext.toolNameMapper`. Request renaming happens at the
 * protocol entry, restoration at the protocol exit — the cross-protocol
 * translate layer transparently carries the already-rewritten names.
 */

import type {
  //
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Message,
  Tool as ChatTool,
  ToolCall,
} from "~/types/api/openai-chat-completions"
import type {
  //
  ResponsesInputItem,
  ResponsesPayload,
  ResponsesTool,
} from "~/types/api/openai-responses"

import { getToolNameRulesForModel } from "~/lib/models/resolver"
import { state } from "~/lib/state"
import {
  //
  createToolNameMapper,
  type ToolNameMapper,
} from "~/lib/tool-name-mapper"

// ============================================================================
// Mapper construction
// ============================================================================

/**
 * Build a tool-name mapper for a Chat Completions request from its function
 * tool definitions. Returns `null` when disabled, when there are no tools, or
 * when nothing needs rewriting.
 */
export function buildChatCompletionsToolNameMapper(payload: ChatCompletionsPayload, vendor?: string): ToolNameMapper | null {
  if (!state.sanitizeToolNames) return null
  // CC tools are always `type: "function"`, so every tool contributes a name.
  const names = (payload.tools ?? []).map((t) => t.function.name)
  if (names.length === 0) return null
  const mapper = createToolNameMapper(names, getToolNameRulesForModel(payload.model, vendor))
  return mapper.hasChanges ? mapper : null
}

/**
 * Build a tool-name mapper for a Responses request from its function tool
 * definitions. Returns `null` when disabled / no tools / no rewrite needed.
 */
export function buildResponsesToolNameMapper(payload: ResponsesPayload, vendor?: string): ToolNameMapper | null {
  if (!state.sanitizeToolNames) return null
  const names = (payload.tools ?? []).filter((t): t is Extract<ResponsesTool, { type: "function" }> => t.type === "function").map((t) => t.name)
  if (names.length === 0) return null
  const mapper = createToolNameMapper(names, getToolNameRulesForModel(payload.model, vendor))
  return mapper.hasChanges ? mapper : null
}

// ============================================================================
// Chat Completions — request renaming
// ============================================================================

/** Rename a tool_call's function name to upstream form when mapped. */
function renameToolCall(call: ToolCall, mapper: ToolNameMapper): ToolCall {
  if (!mapper.hasOriginal(call.function.name)) return call
  return { ...call, function: { ...call.function, name: mapper.toUpstream(call.function.name) } }
}

/** Rename tool_calls inside a single message to upstream form. */
function renameMessageToolCalls(message: Message, mapper: ToolNameMapper): Message {
  if (!message.tool_calls || message.tool_calls.length === 0) return message
  const toolCalls = message.tool_calls.map((call) => renameToolCall(call, mapper))
  const changed = toolCalls.some((call, i) => call !== message.tool_calls?.[i])
  return changed ? { ...message, tool_calls: toolCalls } : message
}

/**
 * Apply tool-name sanitization to an outbound Chat Completions payload: rename
 * tool definitions and tool_calls in messages from original → upstream. Returns
 * a new payload (never mutates input). No-op when `mapper` is null.
 */
export function applyChatCompletionsToolNameSanitization(payload: ChatCompletionsPayload, mapper: ToolNameMapper | null): ChatCompletionsPayload {
  if (!mapper) return payload

  // CC tools are always `type: "function"`.
  const tools = payload.tools?.map((tool: ChatTool) =>
    mapper.hasOriginal(tool.function.name) ? { ...tool, function: { ...tool.function, name: mapper.toUpstream(tool.function.name) } } : tool,
  )
  const messages = payload.messages.map((m) => renameMessageToolCalls(m, mapper))

  return {
    ...payload,
    ...(tools ? { tools } : {}),
    messages,
  }
}

// ============================================================================
// Chat Completions — response restoration
// ============================================================================

/** Restore tool_call names (upstream → original) in a single message. */
function restoreMessageToolCalls(toolCalls: Array<ToolCall> | undefined, mapper: ToolNameMapper): { toolCalls?: Array<ToolCall>; modified: boolean } {
  if (!toolCalls || toolCalls.length === 0) return { toolCalls, modified: false }
  const restored = toolCalls.map((call) => {
    const name = mapper.toClient(call.function.name)
    return name === call.function.name ? call : { ...call, function: { ...call.function, name } }
  })
  const modified = restored.some((call, i) => call !== toolCalls[i])
  return { toolCalls: restored, modified }
}

/**
 * Restore tool_call names in a non-streaming Chat Completions response
 * (`choices[].message.tool_calls[].function.name`). No-op when `mapper` is null.
 * Returns a new response (never mutates input).
 */
export function restoreChatCompletionsToolNames(response: ChatCompletionResponse, mapper: ToolNameMapper | null): ChatCompletionResponse {
  if (!mapper) return response
  const source = response.choices
  const choices = source.map((choice) => {
    const { toolCalls, modified } = restoreMessageToolCalls(choice.message.tool_calls, mapper)
    return modified ? { ...choice, message: { ...choice.message, tool_calls: toolCalls } } : choice
  })
  const anyModified = choices.some((choice, i) => choice !== source[i])
  return anyModified ? { ...response, choices } : response
}

/**
 * Restore tool-call names in a single Chat Completions streaming chunk's
 * `choices[].delta.tool_calls[].function.name`. Operates on a parsed object;
 * returns true when any name was changed (caller re-serializes).
 */
export function restoreChatCompletionsChunkToolNames(chunk: unknown, mapper: ToolNameMapper): boolean {
  if (typeof chunk !== "object" || chunk === null) return false
  const choices = (chunk as { choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { name?: string } }> } }> }).choices
  if (!Array.isArray(choices)) return false
  let modified = false
  for (const choice of choices) {
    const toolCalls = choice.delta?.tool_calls
    if (!Array.isArray(toolCalls)) continue
    for (const call of toolCalls) {
      const fn = call.function
      if (!fn || typeof fn.name !== "string") continue
      const restored = mapper.toClient(fn.name)
      if (restored !== fn.name) {
        fn.name = restored
        modified = true
      }
    }
  }
  return modified
}

// ============================================================================
// Responses — request renaming
// ============================================================================

/** Rename a Responses input item's function_call name to upstream form. */
function renameResponsesInputItem(item: ResponsesInputItem, mapper: ToolNameMapper): ResponsesInputItem {
  if (item.type === "function_call" && typeof item.name === "string" && mapper.hasOriginal(item.name)) {
    return { ...item, name: mapper.toUpstream(item.name) }
  }
  return item
}

/**
 * Apply tool-name sanitization to an outbound Responses payload: rename tool
 * definitions (`tools[].name`) and `function_call` names in the input items.
 * Returns a new payload (never mutates input). No-op when `mapper` is null.
 */
export function applyResponsesToolNameSanitization(payload: ResponsesPayload, mapper: ToolNameMapper | null): ResponsesPayload {
  if (!mapper) return payload

  const tools = payload.tools?.map((tool) =>
    tool.type === "function" && mapper.hasOriginal(tool.name) ? { ...tool, name: mapper.toUpstream(tool.name) } : tool,
  )

  let input = payload.input
  if (Array.isArray(input)) {
    input = input.map((item) => renameResponsesInputItem(item, mapper))
  }

  return {
    ...payload,
    ...(tools ? { tools } : {}),
    input,
  }
}

// ============================================================================
// Responses — response restoration
// ============================================================================

/**
 * Responses SSE event types that can carry a `function_call` name needing
 * restoration: the per-item frames (`item.name`) plus the lifecycle frames
 * whose full `response.output[]` holds function_call items. All other event
 * types never carry a name, so callers can skip JSON parsing for them.
 */
export const RESPONSES_NAME_BEARING_EVENTS = new Set<string>([
  "response.output_item.added",
  "response.output_item.done",
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.failed",
  "response.incomplete",
])

/**
 * Restore `function_call` names (upstream → original) in a non-streaming
 * Responses response output. No-op when `mapper` is null. Returns a new
 * response object (never mutates input).
 */
export function restoreResponsesOutputToolNames<T extends { output?: Array<{ type?: string; name?: string }> }>(response: T, mapper: ToolNameMapper | null): T {
  if (!mapper || !Array.isArray(response.output)) return response
  const source = response.output
  const output = source.map((item) => {
    if (item.type === "function_call" && typeof item.name === "string") {
      const restored = mapper.toClient(item.name)
      if (restored !== item.name) return { ...item, name: restored }
    }
    return item
  })
  const modified = output.some((item, i) => item !== source[i])
  return modified ? { ...response, output } : response
}

/**
 * Restore `function_call` names in a single Responses streaming event's parsed
 * object (upstream → original), mutating it in place. Handles both shapes:
 *
 *   - `response.output_item.added` / `.done` — name lives on `event.item.name`.
 *   - lifecycle events `response.created` / `.in_progress` / `.completed` /
 *     `.failed` / `.incomplete` — carry a full `event.response` whose
 *     `output[]` holds `function_call` items. Standard OpenAI SDK clients
 *     reconstruct the final result from the terminal `response.completed`
 *     event's `output`, so failing to restore here would leak upstream
 *     (sanitized) names even though the per-item frames were restored.
 *
 * Returns true when any name changed (caller re-serializes). No-op otherwise.
 */
export function restoreResponsesEventToolNames(event: unknown, mapper: ToolNameMapper): boolean {
  if (typeof event !== "object" || event === null) return false

  // Per-item frames: name on `event.item`.
  const item = (event as { item?: { type?: string; name?: string } }).item
  if (item && item.type === "function_call" && typeof item.name === "string") {
    const restored = mapper.toClient(item.name)
    if (restored === item.name) return false
    item.name = restored
    return true
  }

  // Lifecycle frames: name(s) inside `event.response.output[]`.
  const output = (event as { response?: { output?: Array<{ type?: string; name?: string }> } }).response?.output
  if (Array.isArray(output)) {
    let changed = false
    for (const out of output) {
      if (out.type === "function_call" && typeof out.name === "string") {
        const restored = mapper.toClient(out.name)
        if (restored !== out.name) {
          out.name = restored
          changed = true
        }
      }
    }
    return changed
  }

  return false
}

/**
 * Restore `function_call` names (upstream → original) in one raw Responses SSE
 * data frame for client forwarding — the shared helper both transports (HTTP
 * `forwardFrame` + WS `forwardWsFrame`) call at the forward point.
 *
 * Re-parses `data` into its OWN object (rather than reusing the caller's
 * accumulator event) so history keeps the upstream names: restoration is a
 * forwarded-only transform, applied AFTER accumulation. No-op when `mapper` is
 * null or the event type never carries a name. Best-effort: returns `data`
 * unchanged on parse failure / no change.
 */
export function restoreResponsesStreamFrameToolNames(data: string, eventType: string, mapper: ToolNameMapper | null): string {
  if (!mapper) return data
  if (!RESPONSES_NAME_BEARING_EVENTS.has(eventType)) return data
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return data
  }
  return restoreResponsesEventToolNames(parsed, mapper) ? JSON.stringify(parsed) : data
}
