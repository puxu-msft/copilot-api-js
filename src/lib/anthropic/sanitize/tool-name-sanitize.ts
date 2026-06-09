/**
 * Per-model tool-name sanitization for the Anthropic path.
 *
 * Builds a deterministic bidirectional name mapper from the client's original
 * custom tools and applies it to outbound requests (tool definitions + tool_use
 * names in messages). Response restoration is handled at the route handler via
 * the same mapper retrieved from `RequestContext.toolNameMapper`.
 *
 * Only client-original custom tools are sanitized — never server tools
 * (web_search, etc.), the tool_search stub, or Claude Code stub tools — because
 * those names are upstream protocol contracts. The mapper snapshot is therefore
 * built from the request's tools BEFORE `preprocessTools` injects any stubs.
 */

import type {
  //
  MessageParam,
  MessagesPayload,
  Tool,
} from "~/types/api/anthropic"

import { getToolNameRulesForModel } from "~/lib/models/resolver"
import { state } from "~/lib/state"
import {
  //
  createToolNameMapper,
  type ToolNameMapper,
} from "~/lib/tool-name-mapper"

import { isServerToolType } from "../message-tools"

/**
 * Build a tool-name mapper for an Anthropic request from its client-original
 * custom tools. Returns `null` when the feature is disabled, there are no
 * custom tools, or no name actually needs rewriting (so the rest of the
 * pipeline can short-circuit to the unmodified path).
 *
 * `vendor` is the resolved model's vendor (when known) used to pick the
 * per-class rules; the model id is the fallback signal.
 */
export function buildAnthropicToolNameMapper(tools: Array<Tool> | undefined, model: string, vendor?: string): ToolNameMapper | null {
  if (!state.sanitizeToolNames) return null
  if (!tools || tools.length === 0) return null

  // Client-original custom tools only: exclude server tools (have a server
  // `type`). The tool_search stub and Claude Code stubs aren't present yet
  // (mapper is built before preprocessTools).
  const customNames = tools.filter((t) => !isServerToolType(t.type)).map((t) => t.name)
  if (customNames.length === 0) return null

  const rules = getToolNameRulesForModel(model, vendor)
  const mapper = createToolNameMapper(customNames, rules)
  return mapper.hasChanges ? mapper : null
}

/** Rename a single tool definition's name to its upstream form when mapped. */
function renameToolDefinition(tool: Tool, mapper: ToolNameMapper): Tool {
  if (!mapper.hasOriginal(tool.name)) return tool
  return { ...tool, name: mapper.toUpstream(tool.name) }
}

/** Rename tool_use block names in a single message to their upstream form. */
function renameMessageToolUse(message: MessageParam, mapper: ToolNameMapper): MessageParam {
  if (typeof message.content === "string") return message
  const source = message.content
  const newContent = source.map((block) => {
    // Only client tool_use blocks carry custom names; server_tool_use is left
    // untouched (it never goes through the mapper's original set).
    if (block.type === "tool_use" && mapper.hasOriginal(block.name)) {
      return { ...block, name: mapper.toUpstream(block.name) }
    }
    return block
  })
  const modified = newContent.some((block, i) => block !== source[i])
  return modified ? { ...message, content: newContent } : message
}

/**
 * Apply the tool-name mapper to an outbound Anthropic payload: rename tool
 * definitions and tool_use block names from client-original to upstream form.
 * Returns a new payload (never mutates input). No-op when `mapper` is null.
 */
export function applyAnthropicToolNameSanitization(payload: MessagesPayload, mapper: ToolNameMapper | null): MessagesPayload {
  if (!mapper) return payload

  const tools = payload.tools?.map((t) => renameToolDefinition(t, mapper))
  const messages = payload.messages.map((m) => renameMessageToolUse(m, mapper))

  return {
    ...payload,
    ...(tools ? { tools } : {}),
    messages,
  }
}
