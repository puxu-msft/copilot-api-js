/**
 * Anthropic Messages API tool preprocessing pipeline.
 *
 * Prepares the tools array before sending to Copilot's /v1/messages endpoint:
 * - Injects Claude Code official tool stubs for missing tools
 * - Applies tool_search / defer_loading based on model capabilities
 * - Ensures all custom tools have input_schema
 * - Injects stubs for tools referenced in message history
 * - Strips server-side tools (web_search, etc.) when configured
 *
 * Must be called BEFORE sanitize — processToolBlocks (in sanitize) uses
 * the tools array to validate tool_use references in messages.
 */

import consola from "consola"

import type { MessageParam, MessagesPayload, Tool } from "~/types/api/anthropic"

import { state } from "~/lib/state"

import { modelSupportsToolSearch } from "./features"

// ============================================================================
// Constants
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

const EMPTY_INPUT_SCHEMA = { type: "object", properties: {}, required: [] } as const

// ============================================================================
// Internal helpers
// ============================================================================

/** Ensure a tool has input_schema — required by Anthropic API for custom tools. */
function ensureInputSchema(tool: Tool): Tool {
  return tool.input_schema ? tool : { ...tool, input_schema: EMPTY_INPUT_SCHEMA }
}

/**
 * Collect tool names referenced in message history via tool_use blocks.
 *
 * When tool_search is enabled, deferred tools must be "loaded" via
 * tool_search_tool_regex before they can be called. But in multi-turn
 * conversations, message history may already contain tool_use blocks
 * referencing tools that were loaded in earlier turns. If we mark those
 * tools as deferred again, the API rejects the request because the
 * historical tool_use references a tool that isn't "loaded" in this turn.
 *
 * By collecting all tool names from history, we ensure those tools remain
 * non-deferred (immediately available) — preserving the tool_use/tool_result
 * pairing that the API requires.
 */
function collectHistoryToolNames(messages: Array<MessageParam>): Set<string> {
  const names = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        names.add(block.name)
      }
    }
  }
  return names
}

/**
 * Build minimal tool stubs for tools referenced in message history.
 *
 * Used when the request has no tools but messages contain tool_use blocks.
 * Only needed when tool search is enabled (advanced-tool-use beta),
 * which enforces tool reference validation.
 */
function buildHistoryToolStubs(historyToolNames: Set<string>): Array<Tool> {
  return Array.from(historyToolNames).map((name) => ({
    name,
    description: `Stub for tool referenced in conversation history`,
    input_schema: EMPTY_INPUT_SCHEMA,
  }))
}

// ============================================================================
// Tool pipeline
// ============================================================================

/**
 * Process tools through the full pipeline:
 * 1. Inject missing Claude Code official tool stubs
 * 2. If model supports tool search: prepend search tool, mark non-core as deferred
 * 3. Ensure all custom tools have input_schema (skip API-defined typed tools)
 *
 * Returns a new array — never mutates the input.
 */
function processToolPipeline(tools: Array<Tool>, modelId: string, messages: Array<MessageParam>): Array<Tool> {
  // Case-insensitive set for Claude Code stub injection — prevents injecting "Read" when
  // the client already has "read" (different casing). Without this, the model sees two
  // similar tools: the client's (with proper schema) and the stub (with empty schema).
  const existingNamesLower = new Set(tools.map((t) => t.name.toLowerCase()))
  const toolSearchEnabled = modelSupportsToolSearch(modelId)

  // Collect tool names already referenced in message history — these must
  // stay non-deferred to avoid "Tool reference not found" errors
  const historyToolNames = toolSearchEnabled ? collectHistoryToolNames(messages) : undefined

  const result: Array<Tool> = []

  // Prepend tool_search_tool_regex if model supports it
  if (toolSearchEnabled) {
    result.push({
      name: TOOL_SEARCH_TOOL_NAME,
      type: TOOL_SEARCH_TOOL_TYPE,
      defer_loading: false,
    })
  }

  // Process existing tools: ensure input_schema, apply defer_loading
  for (const tool of tools) {
    // Tools with a `type` field are API-defined (tool_search, memory, web_search) —
    // schema is managed server-side, don't touch input_schema
    const normalized = tool.type ? tool : ensureInputSchema(tool)

    // Respect explicit defer_loading: false from retry strategies (deferred-tool-retry
    // sets this when a tool was rejected as "not found in available tools")
    const shouldDefer =
      toolSearchEnabled
      && tool.defer_loading !== false
      && !NON_DEFERRED_TOOL_NAMES.has(tool.name)
      && !historyToolNames?.has(tool.name)

    result.push(shouldDefer ? { ...normalized, defer_loading: true } : normalized)
  }

  // Inject stubs for any missing Claude Code official tools
  for (const name of CLAUDE_CODE_OFFICIAL_TOOLS) {
    if (!existingNamesLower.has(name.toLowerCase())) {
      const stub: Tool = {
        name,
        description: `Claude Code ${name} tool`,
        input_schema: EMPTY_INPUT_SCHEMA,
      }
      // Official tools are always non-deferred, no defer_loading needed
      result.push(stub)
    }
  }

  // Inject minimal stubs for tools referenced in message history but missing
  // from the tools array. This happens when MCP tools were available in earlier
  // turns but not included in the current request. Without these stubs, the API
  // rejects the request because the historical tool_use references a tool that
  // doesn't exist in the tools list at all.
  if (historyToolNames) {
    const allResultNames = new Set(result.map((t) => t.name))
    for (const name of historyToolNames) {
      if (!allResultNames.has(name)) {
        consola.debug(`[ToolPipeline] Injecting stub for history-referenced tool: ${name}`)
        result.push({
          name,
          description: `Stub for tool referenced in conversation history`,
          input_schema: EMPTY_INPUT_SCHEMA,
        })
      }
    }
  }

  const deferredCount = result.filter((t) => t.defer_loading === true).length
  const injectedCount = result.length - tools.length
  if (deferredCount > 0 || injectedCount > 0) {
    consola.debug(
      `[ToolPipeline] ${result.length} tools`
        + ` (${deferredCount} deferred, ${injectedCount} injected, tool_search: ${toolSearchEnabled})`,
    )
  }

  return result
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Preprocess tools for an Anthropic request.
 *
 * Must be called BEFORE sanitize — because processToolBlocks (in sanitize)
 * uses the tools array to validate tool_use references. If we run sanitize
 * first with the original (incomplete) tools, it may incorrectly filter
 * tool_use blocks that processToolPipeline would have later provided stubs for.
 *
 * Handles two scenarios:
 * 1. Request has tools → run through processToolPipeline (defer_loading, stubs, tool_search)
 * 2. Request has NO tools but messages have tool_use → inject minimal stubs
 *
 * Returns a new payload (never mutates input).
 */
export function preprocessTools(payload: MessagesPayload): MessagesPayload {
  const tools = payload.tools
  const model = payload.model
  const messages = payload.messages

  if (tools && tools.length > 0) {
    return { ...payload, tools: processToolPipeline(tools, model, messages) }
  }

  // No tools in request — but if tool search is enabled and history has tool_use
  // references, we need stubs to satisfy API validation
  if (modelSupportsToolSearch(model)) {
    const historyToolNames = collectHistoryToolNames(messages)
    if (historyToolNames.size > 0) {
      consola.debug(
        `[ToolPipeline] Injecting ${historyToolNames.size} tool stubs for`
          + ` history references (no tools in request): ${[...historyToolNames].join(", ")}`,
      )
      return { ...payload, tools: buildHistoryToolStubs(historyToolNames) }
    }
  }

  return payload
}

// ============================================================================
// Server Tool Stripping
// ============================================================================

/**
 * Server tool type prefixes recognized by the Anthropic API.
 *
 * Server tools use a `type` field with a dated suffix (e.g., "web_search_20250305")
 * instead of `input_schema`. These are executed by Anthropic's servers, not by the client.
 *
 * Source: @anthropic-ai/sdk ContentBlock / Tool union types.
 */
// prettier-ignore
const SERVER_TOOL_TYPE_PREFIXES = [
  "web_search_",
  "web_fetch_",
  "code_execution_",
  "text_editor_",
  "computer_",
  "bash_",
]

/** Check if a tool's type field matches a known server tool prefix. */
function isServerToolType(type: string | undefined): boolean {
  if (!type) return false
  return SERVER_TOOL_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix))
}

/**
 * Strip server-side tools from the tools array, or pass them through unchanged.
 *
 * When state.stripServerTools is enabled, server tools (web_search,
 * code_execution, etc.) are removed from the request because Copilot's /v1/messages
 * endpoint may not support executing them server-side. Without this, the tools
 * would be silently ignored or cause errors.
 *
 * When disabled (default), server tools are passed through unchanged — the proxy
 * transparently forwards them per the Anthropic protocol.
 */
export function stripServerTools(tools: Array<Tool> | undefined): Array<Tool> | undefined {
  if (!tools) return undefined

  // When stripping is disabled, pass all tools through unchanged
  if (!state.stripServerTools) return tools

  const result: Array<Tool> = []

  for (const tool of tools) {
    if (isServerToolType(tool.type)) {
      consola.warn(`[DirectAnthropic] Stripping server tool: ${tool.name} (type: ${tool.type})`)
      continue
    }
    result.push(tool)
  }

  return result.length > 0 ? result : undefined
}
