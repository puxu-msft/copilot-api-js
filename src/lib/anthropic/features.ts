/**
 * Anthropic model feature detection and request header construction.
 *
 * Mirrors VSCode Copilot Chat's feature detection logic from:
 * - anthropic.ts: modelSupportsInterleavedThinking, modelSupportsContextEditing, modelSupportsToolSearch
 * - chatEndpoint.ts: getExtraHeaders (anthropic-beta, capi-beta-1)
 * - anthropic.ts: buildContextManagement, nonDeferredToolNames
 */

import type { AnthropicTool } from "~/types/api/anthropic"

import { normalizeForMatching } from "~/lib/models/resolver"

// ============================================================================
// Model Feature Detection
// ============================================================================

/**
 * Interleaved thinking is supported by:
 * - Claude Sonnet 4/4.5
 * - Claude Haiku 4.5
 * - Claude Opus 4.5/4.6
 *
 * Notably, claude-opus-4 and claude-opus-4-1 do NOT support interleaved thinking.
 */
export function modelSupportsInterleavedThinking(modelId: string): boolean {
  const normalized = normalizeForMatching(modelId)
  return (
    normalized.startsWith("claude-sonnet-4-5")
    || normalized.startsWith("claude-sonnet-4")
    || normalized.startsWith("claude-haiku-4-5")
    || normalized.startsWith("claude-opus-4-5")
    || normalized.startsWith("claude-opus-4-6")
  )
}

/**
 * Context editing is supported by a broader set of models:
 * - Claude Haiku 4.5
 * - Claude Sonnet 4/4.5
 * - Claude Opus 4/4.1/4.5/4.6
 */
export function modelSupportsContextEditing(modelId: string): boolean {
  const normalized = normalizeForMatching(modelId)
  return (
    normalized.startsWith("claude-haiku-4-5")
    || normalized.startsWith("claude-sonnet-4-5")
    || normalized.startsWith("claude-sonnet-4")
    || normalized.startsWith("claude-opus-4-5")
    || normalized.startsWith("claude-opus-4-6")
    || normalized.startsWith("claude-opus-4-1")
    || normalized.startsWith("claude-opus-4")
  )
}

/**
 * Tool search is supported by:
 * - Claude Opus 4.5/4.6
 */
export function modelSupportsToolSearch(modelId: string): boolean {
  const normalized = normalizeForMatching(modelId)
  return normalized.startsWith("claude-opus-4-5") || normalized.startsWith("claude-opus-4-6")
}

// ============================================================================
// Anthropic Beta Headers
// ============================================================================

export interface AnthropicBetaHeaders {
  /** Comma-separated beta feature identifiers */
  "anthropic-beta"?: string
  /** Fallback for models without interleaved thinking support */
  "capi-beta-1"?: string
}

/**
 * Build anthropic-beta and capi-beta-1 headers based on model capabilities.
 *
 * Logic from chatEndpoint.ts:166-201:
 * - If model supports interleaved thinking → add "interleaved-thinking-2025-05-14"
 * - Otherwise → set "capi-beta-1: true"
 * - If model supports context editing → add "context-management-2025-06-27"
 * - If model supports tool search → add "advanced-tool-use-2025-11-20"
 */
export function buildAnthropicBetaHeaders(modelId: string): AnthropicBetaHeaders {
  const headers: AnthropicBetaHeaders = {}
  const betaFeatures: Array<string> = []

  if (modelSupportsInterleavedThinking(modelId)) {
    betaFeatures.push("interleaved-thinking-2025-05-14")
  } else {
    headers["capi-beta-1"] = "true"
  }

  if (modelSupportsContextEditing(modelId)) {
    betaFeatures.push("context-management-2025-06-27")
  }

  if (modelSupportsToolSearch(modelId)) {
    betaFeatures.push("advanced-tool-use-2025-11-20")
  }

  if (betaFeatures.length > 0) {
    headers["anthropic-beta"] = betaFeatures.join(",")
  }

  return headers
}

// ============================================================================
// Context Management
// ============================================================================

interface ContextManagementEdit {
  type: string
  trigger?: { type: string; value: number }
  keep?: { type: string; value: number }
  clear_at_least?: { type: string; value: number }
  exclude_tools?: Array<string>
  clear_tool_inputs?: boolean
}

export interface ContextManagement {
  edits: Array<ContextManagementEdit>
}

/**
 * Build context_management config for the request body.
 *
 * From anthropic.ts:270-329 (buildContextManagement + getContextManagementFromConfig):
 * - clear_thinking: keep last N thinking turns
 * - clear_tool_uses: triggered by input_tokens threshold, keep last N tool uses
 */
export function buildContextManagement(modelId: string, hasThinking: boolean): ContextManagement | undefined {
  if (!modelSupportsContextEditing(modelId)) {
    return undefined
  }

  // Default config from getContextManagementFromConfig
  const triggerType = "input_tokens"
  const triggerValue = 100_000
  const keepCount = 3
  const thinkingKeepTurns = 1

  const edits: Array<ContextManagementEdit> = []

  // Add clear_thinking only if thinking is enabled
  if (hasThinking) {
    edits.push({
      type: "clear_thinking_20251015",
      keep: { type: "thinking_turns", value: Math.max(1, thinkingKeepTurns) },
    })
  }

  // Always add clear_tool_uses
  edits.push({
    type: "clear_tool_uses_20250919",
    trigger: { type: triggerType, value: triggerValue },
    keep: { type: "tool_uses", value: keepCount },
  })

  return { edits }
}

// ============================================================================
// Tool Search / Defer Loading
// ============================================================================

/**
 * Claude Code official tool names that must always be present in the tools array.
 * If any of these are missing from the request, they will be injected as stub definitions.
 */
const CLAUDE_CODE_OFFICIAL_TOOLS = [
  "Task",
  "TaskOutput",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "TodoWrite",
  "KillShell",
  "AskUserQuestion",
  "Skill",
  "EnterPlanMode",
  "ExitPlanMode",
]

/** Tool names that should NOT be deferred (core tools always available) */
const NON_DEFERRED_TOOL_NAMES = new Set([
  // VSCode Copilot Chat original tool names (snake_case)
  "read_file",
  "list_dir",
  "grep_search",
  "semantic_search",
  "file_search",
  "replace_string_in_file",
  "multi_replace_string_in_file",
  "insert_edit_into_file",
  "apply_patch",
  "create_file",
  "run_in_terminal",
  "get_terminal_output",
  "get_errors",
  "manage_todo_list",
  "runSubagent",
  "search_subagent",
  "runTests",
  "ask_questions",
  "switch_agent",
  // Claude Code official tool names (PascalCase)
  ...CLAUDE_CODE_OFFICIAL_TOOLS,
])

const TOOL_SEARCH_TOOL_NAME = "tool_search_tool_regex"
const TOOL_SEARCH_TOOL_TYPE = "tool_search_tool_regex_20251119"

/**
 * Ensure all Claude Code official tools are present in the tools array.
 * Injects stub definitions for any missing official tools.
 */
export function ensureOfficialTools(tools: Array<AnthropicTool>): Array<AnthropicTool> {
  const existingNames = new Set(tools.map((t) => t.name))
  const missing = CLAUDE_CODE_OFFICIAL_TOOLS.filter((name) => !existingNames.has(name))

  if (missing.length === 0) {
    return tools
  }

  const result = [...tools]
  for (const name of missing) {
    result.push({
      name,
      description: `Claude Code ${name} tool`,
      input_schema: { type: "object" },
    })
  }

  return result
}

/**
 * Apply tool search to the tools list.
 *
 * From anthropic.ts and messagesApi.ts:
 * - Prepend tool_search_tool_regex tool
 * - Mark non-core tools with defer_loading: true
 * - Core tools (VSCode + Claude Code official) keep defer_loading: false
 */
export function applyToolSearch(tools: Array<AnthropicTool>, modelId: string): Array<AnthropicTool> {
  if (!modelSupportsToolSearch(modelId) || tools.length === 0) {
    return tools
  }

  const result: Array<AnthropicTool> = []

  // 1. Add tool_search_tool_regex at the beginning
  result.push({
    name: TOOL_SEARCH_TOOL_NAME,
    type: TOOL_SEARCH_TOOL_TYPE,
  })

  // 2. Add tools with defer_loading based on whether they're core tools
  for (const tool of tools) {
    if (NON_DEFERRED_TOOL_NAMES.has(tool.name)) {
      result.push(tool) // Core tool: no defer_loading
    } else {
      result.push({ ...tool, defer_loading: true })
    }
  }

  return result
}
