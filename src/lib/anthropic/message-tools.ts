/**
 * Anthropic Messages API tool preprocessing pipeline.
 *
 * Prepares the tools array before sending to Copilot's /v1/messages endpoint:
 * - Injects Claude Code official tool stubs for missing tools
 * - Applies tool_search / defer_loading based on model capabilities
 * - Ensures all custom tools have input_schema
 * - Injects stubs for tools referenced in message history
 * - Strips API-defined typed tools reactively learned as upstream-unsupported
 *
 * Must be called BEFORE sanitize — processToolBlocks (in sanitize) uses
 * the tools array to validate tool_use references in messages.
 */

import consola from "consola"

import type { Model } from "~/lib/models/client"
import type {
  //
  MessageParam,
  MessagesPayload,
  Tool,
} from "~/types/api/anthropic"

import { applyStickyUndeferredTools } from "~/lib/request/strategies/deferred-tool-retry"
import { state } from "~/lib/state"

import {
  //
  getUnsupportedServerToolTypes,
  getUnsupportedToolFields,
} from "./feature-negotiation"
import { modelSupportsToolSearch } from "./features"
import { collectAllMatching } from "./per-model-config"

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
function processToolPipeline(tools: Array<Tool>, modelId: string, messages: Array<MessageParam>, resolvedModel?: Model): Array<Tool> {
  // Case-insensitive set for Claude Code stub injection — prevents injecting "Read" when
  // the client already has "read" (different casing). Without this, the model sees two
  // similar tools: the client's (with proper schema) and the stub (with empty schema).
  const existingNamesLower = new Set(tools.map((t) => t.name.toLowerCase()))
  const toolSearchEnabled = state.toolSearchEnabled && modelSupportsToolSearch(modelId, resolvedModel)

  // Collect tool names already referenced in message history. Two independent
  // consumers below:
  //  - shouldDefer (tool_search only): these must stay non-deferred to avoid
  //    "Tool reference not found" errors — gated by its own `toolSearchEnabled &&`.
  //  - the history-stub safety net (Path 2 below): name-agnostic, applies regardless
  //    of tool_search — an orphaned historical tool_use gets rejected by GHC whether
  //    or not tool_search is on, so this must NOT be gated on toolSearchEnabled.
  const historyToolNames = collectHistoryToolNames(messages)

  const nonDeferred: Array<Tool> = []
  const deferred: Array<Tool> = []
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
    // Tools with a `type` field are API-defined (tool_search, memory, etc.) —
    // schema is predefined, don't touch input_schema
    const normalized = tool.type ? tool : ensureInputSchema(tool)

    // Respect explicit defer_loading: false from retry strategies (deferred-tool-retry
    // sets this when a tool was rejected as "not found in available tools")
    const shouldDefer =
      toolSearchEnabled
      && tool.defer_loading !== false
      && !NON_DEFERRED_TOOL_NAMES.has(tool.name)
      && !state.nonDeferredTools.includes(tool.name)
      && !historyToolNames.has(tool.name)

    if (shouldDefer) {
      deferred.push({ ...normalized, defer_loading: true })
    } else {
      nonDeferred.push(normalized)
    }
  }

  // Inject stubs for any missing Claude Code official tools.
  //
  // Why this exists: Claude Code clients sometimes send a request where the
  // tool_use blocks in message history reference tools that aren't present
  // in the current `tools` array. Without stubs, the upstream rejects the
  // request because the historical tool_use has no matching declaration.
  //
  // Why it's configurable: clients other than Claude Code (raw SDK callers,
  // custom integrations) have no reason to receive 16 unused stub tools in
  // every prompt — it wastes prompt budget and shapes model behavior toward
  // tool-calling for a workload that may be plain Q&A. Operators disable via
  // `anthropic.tool_inject_claude_code: false`.
  if (state.injectClaudeCodeOfficialTools) {
    for (const name of CLAUDE_CODE_OFFICIAL_TOOLS) {
      if (!existingNamesLower.has(name.toLowerCase())) {
        const stub: Tool = {
          name,
          description: `Claude Code ${name} tool`,
          input_schema: EMPTY_INPUT_SCHEMA,
        }
        nonDeferred.push(stub)
      }
    }
  }

  // Inject minimal stubs for tools referenced in message history but missing
  // from the tools array. This happens when MCP tools were available in earlier
  // turns but not included in the current request. Without these stubs, the API
  // rejects the request because the historical tool_use references a tool that
  // doesn't exist in the tools list at all.
  if (historyToolNames.size > 0) {
    const allResultNames = new Set([...nonDeferred, ...deferred, ...result].map((t) => t.name))
    for (const name of historyToolNames) {
      if (!allResultNames.has(name)) {
        consola.debug(`[ToolPipeline] Injecting stub for history-referenced tool: ${name}`)
        nonDeferred.push({
          name,
          description: `Stub for tool referenced in conversation history`,
          input_schema: EMPTY_INPUT_SCHEMA,
        })
      }
    }
  }

  result.push(...nonDeferred, ...deferred)

  const deferredCount = result.filter((t) => t.defer_loading === true).length
  const injectedCount = result.length - tools.length
  if (deferredCount > 0 || injectedCount > 0) {
    consola.debug(`[ToolPipeline] ${result.length} tools` + ` (${deferredCount} deferred, ${injectedCount} injected, tool_search: ${toolSearchEnabled})`)
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
  // Resolve the Model so tool_search can be metadata-first (supports.tool_search) with the config
  // name-list as fallback — modelIndex is keyed by the resolved id, which `payload.model` carries here.
  const resolvedModel = state.modelIndex.get(model)

  let processed: MessagesPayload
  if (tools && tools.length > 0) {
    processed = { ...payload, tools: processToolPipeline(tools, model, messages, resolvedModel) }
  } else if (state.toolSearchEnabled && modelSupportsToolSearch(model, resolvedModel)) {
    // No tools in request — but if tool search is enabled and history has tool_use
    // references, we need stubs to satisfy API validation
    const historyToolNames = collectHistoryToolNames(messages)
    if (historyToolNames.size > 0) {
      consola.debug(
        `[ToolPipeline] Injecting ${historyToolNames.size} tool stubs for` + ` history references (no tools in request): ${[...historyToolNames].join(", ")}`,
      )
      processed = { ...payload, tools: buildHistoryToolStubs(historyToolNames) }
    } else {
      processed = payload
    }
  } else {
    processed = payload
  }

  // Apply persisted sticky-undefer decisions from prior `deferred-tool-retry` runs
  const { payload: withSticky, affected } = applyStickyUndeferredTools(processed)
  if (affected.length > 0) {
    consola.debug(`[ToolPipeline] Applied sticky un-defer for ${model}: ${affected.join(", ")}`)
  }
  return withSticky
}

// ============================================================================
// Server Tool Stripping
// ============================================================================

/**
 * API-defined typed-tool prefixes recognized by the Anthropic API.
 *
 * These tools declare a `type` field with a dated suffix (e.g. "web_search_20250305")
 * instead of `input_schema` — the schema is predefined by Anthropic. This is a
 * distinct category from custom function tools (which carry `input_schema`).
 *
 * NOTE — being API-defined does NOT mean server-executed. Two sub-kinds share this
 * prefix set: server-executed tools (web_search / web_fetch / code_execution, which
 * emit `server_tool_use` and are run on Anthropic's servers) AND client-executed
 * builtin tools (text_editor / computer / bash, which emit a plain `tool_use` +
 * `caller:{type:"direct"}` and are run by the client — like `memory`). See ADR
 * docs/decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md.
 *
 * Source: @anthropic-ai/sdk ContentBlock / Tool union types.
 */
// prettier-ignore
const API_DEFINED_TOOL_TYPE_PREFIXES = [
  "web_search_",
  "web_fetch_",
  "code_execution_",
  "text_editor_",
  "computer_",
  "bash_",
  // CC 2.1.207 additions (F32) — server-tool `type` values seen in app.pretty.js.
  "advisor_",
  "agent_toolset_",
  "memory_",
  "tool_search_",
]

/** Check whether a tool's `type` matches a known API-defined typed-tool prefix (NOT necessarily server-executed — see above). */
export function isApiDefinedToolType(type: string | undefined): boolean {
  if (!type) return false
  return API_DEFINED_TOOL_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix))
}

/**
 * Strip server-side tools from the tools array, or pass them through unchanged.
 *
 * Two reactive strip sources are unioned (the global `server_tool_strip` config
 * opt-in was removed with the web_search retirement — 2026-07-13):
 *   1. learned cache (`getUnsupportedServerToolTypes(model)`) — per-(endpoint,
 *      model) type prefixes the upstream reactively rejected (e.g. `web_search_`).
 *   2. `excludeTypes` — per-attempt hint from the server-tool-rejection retry
 *      strategy (`PrepareHints.excludeServerToolTypes`), deterministic for THIS
 *      attempt independent of whether the cache was written yet.
 *
 * Both strip only the matching type prefixes; other server tools pass through.
 * When neither applies (default), all tools are forwarded unchanged per the
 * Anthropic protocol.
 */
export function stripServerTools(tools: Array<Tool> | undefined, model: string, excludeTypes?: ReadonlyArray<string>): Array<Tool> | undefined {
  if (!tools) return undefined

  const learned = new Set([...getUnsupportedServerToolTypes(model), ...(excludeTypes ?? [])])

  // No learned/hinted type strips anything — forward unchanged.
  if (learned.size === 0) return tools

  const result: Array<Tool> = []

  for (const tool of tools) {
    const matchesLearned = [...learned].some((prefix) => (tool.type ?? "").startsWith(prefix))
    if (isApiDefinedToolType(tool.type) && matchesLearned) {
      consola.warn(`[DirectAnthropic] Stripping server tool: ${tool.name} (type: ${tool.type})`)
      continue
    }
    result.push(tool)
  }

  return result.length > 0 ? result : undefined
}

// ============================================================================
// Unknown Tool-Field Stripping
// ============================================================================

/**
 * Custom-tool top-level fields ALWAYS stripped before sending upstream. Seeded
 * with `eager_input_streaming` — a newer client-side tool-input streaming hint
 * that newer Claude Code attaches to every tool, which GHC's upstream Anthropic
 * API rejects with `tools.N.custom.eager_input_streaming: Extra inputs are not
 * permitted`. Empirically verified inert (pure streaming optimization; output is
 * identical when stripped). Additive with config `tool_strip_fields` and the
 * reactive negotiation cache; reversible via config `tool_keep_fields`.
 */
export const BUILTIN_STRIP_TOOL_FIELDS: ReadonlyArray<string> = ["eager_input_streaming"]

/**
 * Tool keys GHC's upstream legitimately models. NEVER stripped: if the upstream
 * ever reports one of these as "Extra inputs are not permitted", that signals a
 * variant-misrouting bug (some transform corrupted the tool's discriminator so
 * pydantic landed on the wrong union arm), which must surface as a loud 400 for
 * investigation — NOT be silently swallowed by stripping a legitimate field.
 */
export const LEGIT_TOOL_KEYS: ReadonlySet<string> = new Set(["name", "description", "input_schema", "type", "defer_loading", "cache_control"])

/**
 * Strip unknown/rejected top-level fields from every custom tool. The strip set:
 *
 *   BUILTIN ∪ config `tool_strip_fields`(model) ∪ endpoint-learned cache ∪ excludeFields
 *     − config `tool_keep_fields`(model) − LEGIT_TOOL_KEYS
 *
 * `excludeFields` is the per-attempt authoritative hint from the
 * tool-field-rejection retry strategy (deterministic for THIS attempt,
 * independent of whether the cache was written yet). Learned cache is
 * endpoint-level (model-agnostic) — the rejection is an upstream-version
 * property. Returns a new array; never mutates the input.
 */
export function stripToolFields(tools: Array<Tool> | undefined, model: string, excludeFields?: ReadonlyArray<string>): Array<Tool> | undefined {
  if (!tools) return tools

  const strip = new Set<string>(BUILTIN_STRIP_TOOL_FIELDS)
  for (const fields of collectAllMatching(model, state.stripToolFields)) for (const f of fields) strip.add(f)
  for (const f of getUnsupportedToolFields()) strip.add(f)
  if (excludeFields) for (const f of excludeFields) strip.add(f)

  // Subtract the reversibility keep-list, then the never-strip legit keys.
  for (const fields of collectAllMatching(model, state.keepToolFields)) for (const f of fields) strip.delete(f)
  for (const k of LEGIT_TOOL_KEYS) strip.delete(k)

  if (strip.size === 0) return tools

  const strippedFields = new Set<string>()
  let affected = 0
  const result = tools.map((tool) => {
    // Copy only the non-stripped keys (avoids a dynamic `delete` on a computed key).
    const next: Record<string, unknown> = {}
    let toolChanged = false
    for (const [key, value] of Object.entries(tool)) {
      if (strip.has(key)) {
        strippedFields.add(key)
        toolChanged = true
        continue
      }
      next[key] = value
    }
    if (toolChanged) affected++
    return next as unknown as Tool
  })

  if (strippedFields.size > 0) {
    // Observability with signal/noise balance: NOTABLE strips (config-declared,
    // reactively learned, or a per-attempt hint — i.e. anything beyond the
    // built-in baseline) warn; a strip consisting ONLY of the built-in default
    // (`eager_input_streaming`, present on every Claude Code tool) logs at debug,
    // since warning on every request would drown genuine alerts. Either way the
    // proactive strip is recorded (not silent) — see richest-data-flow.
    const builtin = new Set(BUILTIN_STRIP_TOOL_FIELDS)
    const notable = [...strippedFields].some((field) => !builtin.has(field))
    const log = notable ? consola.warn : consola.debug
    log(`[DirectAnthropic] Stripped tool field(s) from ${affected}/${tools.length} tool(s): ${[...strippedFields].join(", ")}`)
  }

  return result
}
