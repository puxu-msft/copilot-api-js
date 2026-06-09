/**
 * Detection helpers for native web_search server tools on Anthropic requests.
 *
 * Recognizes both forms:
 *   - The Anthropic native server tool: `{ name: "web_search", type: "web_search_*" }`
 *     (the dated type variant the SDK ships, e.g. "web_search_20250305").
 *   - Claude Code's `WebSearch` tool name (function-style, no server type).
 */

import type {
  //
  MessagesPayload,
  Tool,
} from "~/types/api/anthropic"

import { isServerToolType } from "~/lib/anthropic/message-tools"

/** Claude Code's web search tool name. */
const CLAUDE_CODE_WEB_SEARCH_TOOL_NAME = "WebSearch"

/** Check whether a tool is a native web_search server tool (or Claude Code's WebSearch). */
export function isWebSearchTool(tool: Tool): boolean {
  if (tool.name === CLAUDE_CODE_WEB_SEARCH_TOOL_NAME) return true
  // Native Anthropic web_search: name "web_search" + a server tool type starting with "web_search_".
  return tool.name === "web_search" && isServerToolType(tool.type) && (tool.type?.startsWith("web_search_") ?? false)
}

/** Check whether a payload carries any native web_search server tool. */
export function payloadHasWebSearch(payload: MessagesPayload): boolean {
  return payload.tools?.some((tool) => isWebSearchTool(tool)) ?? false
}
