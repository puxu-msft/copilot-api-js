/**
 * Direct Anthropic-style message API for Copilot.
 *
 * Owns the full request lifecycle: wire payload construction, header building,
 * model-aware request enrichment (beta headers, context management, tool pipeline),
 * and HTTP execution against Copilot's /v1/messages endpoint.
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"
import { events } from "fetch-event-stream"

import type { MessagesPayload, Message as AnthropicResponse, Tool } from "~/types/api/anthropic"

import { copilotBaseUrl, copilotHeaders } from "~/lib/config/api"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import { modelSupportsContextEditing, modelSupportsInterleavedThinking, modelSupportsToolSearch } from "./features"
import { convertServerToolsToCustom } from "./sanitize"

/** Re-export the response type for consumers */
export type AnthropicMessageResponse = AnthropicResponse

// ============================================================================
// Wire payload construction
// ============================================================================

/**
 * Fields known to be rejected by Copilot's Anthropic API endpoint
 * with "Extra inputs are not permitted".
 *
 * We use a blacklist instead of a whitelist so that new Anthropic fields
 * are forwarded by default — no code change needed when Copilot adds support.
 */
const COPILOT_REJECTED_FIELDS = new Set(["output_config", "inference_geo"])

/**
 * Build the wire payload: strip rejected fields and convert server tools.
 * Returns a plain record — the wire format may carry fields beyond what
 * MessagesPayload declares (e.g. context_management), so we don't pretend
 * it's a typed struct.
 */
function buildWirePayload(payload: MessagesPayload): Record<string, unknown> {
  const wire: Record<string, unknown> = {}
  const rejectedFields: Array<string> = []

  for (const [key, value] of Object.entries(payload)) {
    if (COPILOT_REJECTED_FIELDS.has(key)) {
      rejectedFields.push(key)
    } else {
      wire[key] = value
    }
  }

  if (rejectedFields.length > 0) {
    consola.debug(`[DirectAnthropic] Stripped rejected fields: ${rejectedFields.join(", ")}`)
  }

  // Convert server-side tools (web_search, etc.) to custom tool equivalents
  if (wire.tools) {
    wire.tools = convertServerToolsToCustom(wire.tools as Array<Tool>)
  }

  return wire
}

/**
 * Ensure max_tokens > budget_tokens when thinking is enabled.
 *
 * Anthropic API requires max_tokens > thinking.budget_tokens. Some clients
 * send budget_tokens >= max_tokens. We cap budget_tokens to max_tokens - 1,
 * matching the approach in vscode-copilot-chat (messagesApi.ts:132).
 */
function adjustThinkingBudget(wire: Record<string, unknown>): void {
  const thinking = wire.thinking as MessagesPayload["thinking"]
  if (!thinking || thinking.type === "disabled" || thinking.type === "adaptive") return

  const budgetTokens = thinking.budget_tokens
  if (!budgetTokens) return

  const maxTokens = wire.max_tokens as number
  if (budgetTokens >= maxTokens) {
    const adjusted = maxTokens - 1
    ;(wire.thinking as { budget_tokens: number }).budget_tokens = adjusted
    consola.debug(
      `[DirectAnthropic] Capped thinking.budget_tokens: ${budgetTokens} → ${adjusted} ` + `(max_tokens=${maxTokens})`,
    )
  }
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
function buildAnthropicBetaHeaders(modelId: string): AnthropicBetaHeaders {
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
function buildContextManagement(modelId: string, hasThinking: boolean): ContextManagement | undefined {
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
// Tool Pipeline
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

/** Ensure a tool has input_schema — required by Anthropic API for custom tools. */
function ensureInputSchema(tool: Tool): Tool {
  return tool.input_schema ? tool : { ...tool, input_schema: EMPTY_INPUT_SCHEMA }
}

/**
 * Process tools through the full pipeline:
 * 1. Inject missing Claude Code official tool stubs
 * 2. If model supports tool search: prepend search tool, mark non-core as deferred
 * 3. Ensure all custom tools have input_schema (skip API-defined typed tools)
 *
 * Returns a new array — never mutates the input.
 */
function processToolPipeline(tools: Array<Tool>, modelId: string): Array<Tool> {
  const existingNames = new Set(tools.map((t) => t.name))
  const toolSearchEnabled = modelSupportsToolSearch(modelId)

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
    result.push(
      toolSearchEnabled && !NON_DEFERRED_TOOL_NAMES.has(tool.name) ?
        { ...normalized, defer_loading: true }
      : normalized,
    )
  }

  // Inject stubs for any missing Claude Code official tools
  for (const name of CLAUDE_CODE_OFFICIAL_TOOLS) {
    if (!existingNames.has(name)) {
      const stub: Tool = {
        name,
        description: `Claude Code ${name} tool`,
        input_schema: EMPTY_INPUT_SCHEMA,
      }
      // Official tools are always non-deferred, no defer_loading needed
      result.push(stub)
    }
  }

  return result
}

// ============================================================================
// Main entry point — createAnthropicMessages
// ============================================================================

/**
 * Create messages using Anthropic-style API directly.
 * This bypasses the OpenAI translation layer for Anthropic models.
 */
export async function createAnthropicMessages(
  payload: MessagesPayload,
): Promise<AnthropicMessageResponse | AsyncGenerator<ServerSentEventMessage>> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const wire = buildWirePayload(payload)
  adjustThinkingBudget(wire)

  // Destructure known fields for typed access
  const model = wire.model as string
  const messages = wire.messages as MessagesPayload["messages"]
  const tools = wire.tools as Array<Tool> | undefined
  const thinking = wire.thinking as MessagesPayload["thinking"]

  // Check for vision content
  const enableVision = messages.some((msg) => {
    if (typeof msg.content === "string") return false
    return msg.content.some((block) => block.type === "image")
  })

  // Agent/user check for X-Initiator header
  const isAgentCall = messages.some((msg) => msg.role === "assistant")

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
    "anthropic-version": "2023-06-01",
    ...buildAnthropicBetaHeaders(model),
  }

  // Add context_management if model supports it and payload doesn't already have one
  if (!wire.context_management) {
    const hasThinking = Boolean(thinking && thinking.type !== "disabled")
    const contextManagement = buildContextManagement(model, hasThinking)
    if (contextManagement) {
      wire.context_management = contextManagement
      consola.debug("[DirectAnthropic] Added context_management:", JSON.stringify(contextManagement))
    }
  }

  // Process tools through pipeline
  if (tools && tools.length > 0) {
    wire.tools = processToolPipeline(tools, model)
  }

  consola.debug("Sending direct Anthropic request to Copilot /v1/messages")

  const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(wire),
  })

  if (!response.ok) {
    consola.debug("Request failed:", {
      model,
      max_tokens: wire.max_tokens,
      stream: wire.stream,
      toolCount: tools?.length ?? 0,
      thinking,
      messageCount: messages.length,
    })
    throw await HTTPError.fromResponse("Failed to create Anthropic messages", response, model)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as AnthropicMessageResponse
}
