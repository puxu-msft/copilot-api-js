import consola from "consola"

import type { Model } from "~/lib/models/client"

import { copilotHeaders } from "~/lib/copilot-api"
import { setAnthropicBehavior, state } from "~/lib/state"
import { type MessagesPayload, type OutputConfig, type Tool, EFFORT_LEVELS } from "~/types/api/anthropic"

import { isAnthropicFeatureUnsupported } from "./feature-negotiation"
import {
  buildAnthropicBetaHeaders,
  buildContextManagement,
  isContextEditingEnabled,
  mergeAnthropicBeta,
} from "./features"
import { stripServerTools } from "./message-tools"

export interface PreparedAnthropicRequest {
  wire: Record<string, unknown>
  headers: Record<string, string>
}

interface PrepareAnthropicRequestOptions {
  resolvedModel?: Model
  /**
   * Client-sent `anthropic-beta` header (raw comma-separated string).
   * Merged with locally-built beta features so SDK-provided betas survive.
   * Mirrors GHC #4945 fix.
   */
  clientAnthropicBeta?: string
}

const COPILOT_REJECTED_FIELDS = new Set(["inference_geo"])
const CACHE_CONTROL_BREAKPOINT_LIMIT = 4
const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const

export function prepareAnthropicRequest(
  payload: MessagesPayload,
  opts?: PrepareAnthropicRequestOptions,
): PreparedAnthropicRequest {
  const wire = buildWirePayload(payload)
  adjustThinkingBudget(wire, opts?.resolvedModel)
  clampEffortLevel(wire, opts?.resolvedModel)
  applyCacheControlMode(wire)

  const model = wire.model as string
  const messages = wire.messages as MessagesPayload["messages"]
  const thinking = wire.thinking as MessagesPayload["thinking"]

  const enableVision = messages.some((msg) => {
    if (typeof msg.content === "string") return false
    return msg.content.some((block) => block.type === "image")
  })

  const isAgentCall = messages.some((msg) => msg.role === "assistant")
  const modelSupportsVision = opts?.resolvedModel?.capabilities?.supports?.vision !== false
  const contextManagementDisabled =
    wire.context_management === null || isAnthropicFeatureUnsupported(model, "context_management")

  if (contextManagementDisabled) {
    delete wire.context_management
  }

  const localBeta = buildAnthropicBetaHeaders(model, opts?.resolvedModel, {
    disableContextManagement: contextManagementDisabled,
  })
  const mergedBeta = mergeAnthropicBeta(opts?.clientAnthropicBeta, localBeta["anthropic-beta"])

  const headers: Record<string, string> = {
    ...copilotHeaders(state, {
      vision: enableVision && modelSupportsVision,
      modelRequestHeaders: opts?.resolvedModel?.request_headers,
      intent: isAgentCall ? "conversation-agent" : "conversation-panel",
    }),
    "X-Initiator": isAgentCall ? "agent" : "user",
    "anthropic-version": "2023-06-01",
  }
  if (mergedBeta) headers["anthropic-beta"] = mergedBeta

  if (!contextManagementDisabled && !("context_management" in wire) && isContextEditingEnabled(model)) {
    const hasThinking = Boolean(thinking && thinking.type !== "disabled")
    const contextManagement = buildContextManagement(state.contextEditingMode, hasThinking)
    if (contextManagement) {
      wire.context_management = contextManagement
      consola.debug("[DirectAnthropic] Added context_management:", JSON.stringify(contextManagement))
    }
  }

  return { wire, headers }
}

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

  if (wire.tools) {
    wire.tools = stripServerTools(wire.tools as Array<Tool>)
  }

  return wire
}

function adjustThinkingBudget(wire: Record<string, unknown>, resolvedModel?: Model): void {
  const thinking = wire.thinking as MessagesPayload["thinking"]
  if (!thinking || thinking.type === "disabled" || thinking.type === "adaptive") return

  const budgetTokens = thinking.budget_tokens
  if (!budgetTokens) return

  let adjusted = budgetTokens
  const minBudget = resolvedModel?.capabilities?.supports?.min_thinking_budget
  const maxBudget = resolvedModel?.capabilities?.supports?.max_thinking_budget
  const maxTokens = wire.max_tokens as number | undefined

  if (typeof minBudget === "number" && adjusted < minBudget) {
    adjusted = minBudget
  }

  if (typeof maxBudget === "number" && adjusted > maxBudget) {
    adjusted = maxBudget
  }

  if (typeof maxTokens === "number" && adjusted >= maxTokens) {
    adjusted = maxTokens - 1
  }

  if (adjusted !== budgetTokens) {
    ;(wire.thinking as { budget_tokens: number }).budget_tokens = adjusted
    consola.debug(
      `[DirectAnthropic] Capped thinking.budget_tokens: ${budgetTokens} → ${adjusted} (max_tokens=${maxTokens})`,
    )
  }
}

// ============================================================================
// Effort level clamping
// ============================================================================

/**
 * Parse an `invalid_reasoning_effort` upstream error and extract the supported values.
 * Example error body:
 *   {"error":{"message":"output_config.effort \"high\" is not supported by model claude-opus-4.7; supported values: [medium]","code":"invalid_reasoning_effort"}}
 *
 * Returns { modelName, supported } if the error matches, otherwise null.
 */
export function parseInvalidEffortError(responseText: string): { modelName: string; supported: Array<string> } | null {
  // Find the "supported values: [...]" list and the "model X;" identifier.
  // The outer JSON may be double-wrapped so operate on the raw text.
  const codeMatch = responseText.includes("invalid_reasoning_effort")
  if (!codeMatch) return null

  const modelMatch = /by model ([^;"]+)[;"]/.exec(responseText)
  const supportedMatch = /supported values:\s*\[([^\]]*)\]/.exec(responseText)
  if (!modelMatch || !supportedMatch) return null

  const modelName = modelMatch[1].trim()
  const supported = supportedMatch[1]
    .split(",")
    .map((s) => s.trim().replaceAll(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0)

  if (supported.length === 0) return null
  return { modelName, supported }
}

/**
 * Dynamically update learnedEffortsOverrides from an upstream `invalid_reasoning_effort` error.
 * Adds/overwrites the entry for the exact model name (in-memory only, not persisted).
 * Config-sourced `effortsOverrides` remains untouched. Returns true if the state was updated.
 * Emits an info-level log on first-time learning (visible in TUI as `[INFO]`).
 */
export function learnEffortsFromError(responseText: string): boolean {
  const parsed = parseInvalidEffortError(responseText)
  if (!parsed) return false

  const current = state.learnedEffortsOverrides
  const existing = current[parsed.modelName]
  const isFirstLearn = !existing
  // Skip if the existing entry already matches
  if (existing && existing.length === parsed.supported.length && existing.every((e, i) => e === parsed.supported[i])) {
    return false
  }

  const next = { ...current, [parsed.modelName]: parsed.supported }
  setAnthropicBehavior({ learnedEffortsOverrides: next })
  if (isFirstLearn) {
    consola.info(
      `[DirectAnthropic] Learned supported efforts for ${parsed.modelName}: [${parsed.supported.join(", ")}]`,
    )
  } else {
    consola.debug(
      `[DirectAnthropic] Updated supported efforts for ${parsed.modelName}: [${parsed.supported.join(", ")}]`,
    )
  }
  return true
}

/**
 * Find the supported-effort whitelist for a given model name.
 *
 * Priority (highest → lowest):
 *   1. Config-sourced `effortsOverrides` (explicit operator override)
 *   2. Runtime-learned entries (observed via `invalid_reasoning_effort` errors)
 *   3. Model metadata `capabilities.supports.reasoning_effort` (upstream declaration)
 *
 * Reading metadata as a fallback lets us skip the first-round 400 for models
 * that declare effort support upfront (mirrors GHC #5010 precheck), while still
 * allowing operators to override via config when metadata is inaccurate.
 */
export function findSupportedEfforts(modelName: string, resolvedModel?: Model): Array<string> | undefined {
  // Check config first
  for (const [pattern, supported] of Object.entries(state.effortsOverrides)) {
    if (modelName.includes(pattern) && supported.length > 0) {
      return supported
    }
  }
  // Fall back to runtime-learned
  for (const [pattern, supported] of Object.entries(state.learnedEffortsOverrides)) {
    if (modelName.includes(pattern) && supported.length > 0) {
      return supported
    }
  }
  // Last resort: model metadata (from /models API)
  const metadataEfforts = resolvedModel?.capabilities?.supports?.reasoning_effort
  if (Array.isArray(metadataEfforts) && metadataEfforts.length > 0) {
    return metadataEfforts
  }
  return undefined
}

/**
 * Adjust output_config.effort to fit the supported whitelist for the resolved model.
 * Always clamps to the nearest supported value:
 *   - Above max supported → max supported
 *   - Below min supported → min supported
 *   - Within range → pass through
 *
 * Some models (e.g. opus 4.6-1m) only support low/medium/high and reject xhigh/max.
 * Some models (e.g. opus 4.7) only support medium.
 */
function clampEffortLevel(wire: Record<string, unknown>, resolvedModel?: Model): void {
  const outputConfig = wire.output_config as OutputConfig | undefined
  if (!outputConfig?.effort) return

  const modelName = resolvedModel?.id ?? (wire.model as string)
  if (!modelName) return

  const supported = findSupportedEfforts(modelName, resolvedModel)
  if (!supported) return

  // Compute min/max indices of supported efforts
  const supportedIndices = supported
    .map((e) => EFFORT_LEVELS.indexOf(e as (typeof EFFORT_LEVELS)[number]))
    .filter((i) => i >= 0)
  if (supportedIndices.length === 0) return

  const minIndex = Math.min(...supportedIndices)
  const maxIndex = Math.max(...supportedIndices)
  const minEffort = EFFORT_LEVELS[minIndex]
  const maxEffort = EFFORT_LEVELS[maxIndex]

  const currentIndex = EFFORT_LEVELS.indexOf(outputConfig.effort as (typeof EFFORT_LEVELS)[number])
  // Unknown effort level — treat as overflow (above max)
  const isOverflow = currentIndex === -1 || currentIndex > maxIndex
  const isUnderflow = currentIndex >= 0 && currentIndex < minIndex

  if (isOverflow) {
    const original = outputConfig.effort
    ;(wire.output_config as OutputConfig).effort = maxEffort
    consola.debug(`[DirectAnthropic] Clamped output_config.effort: ${original} → ${maxEffort} (model=${modelName})`)
  } else if (isUnderflow) {
    const original = outputConfig.effort
    ;(wire.output_config as OutputConfig).effort = minEffort
    consola.debug(`[DirectAnthropic] Raised output_config.effort: ${original} → ${minEffort} (model=${modelName})`)
  }
  // else: currentIndex within [min, max], pass through
}

// ============================================================================
// Cache control
// ============================================================================

/**
 * Dispatch cache_control handling based on the configured mode.
 * - disabled:    strip all cache_control from the wire payload
 * - passthrough: leave everything as-is
 * - sanitize:    normalize all cache_control to { type: "ephemeral" }
 * - proxied:     strip client cache_control then auto-inject breakpoints
 */
function applyCacheControlMode(wire: Record<string, unknown>): void {
  switch (state.cacheControlMode) {
    case "disabled": {
      walkCacheControl(wire, () => undefined)
      break
    }
    case "passthrough": {
      break
    }
    case "sanitize": {
      walkCacheControl(wire, () => EPHEMERAL_CACHE_CONTROL)
      break
    }
    case "proxied": {
      // Match GHC behavior: strip all client cache_control first, then inject our own.
      // GHC reconstructs content from scratch so client cache_control never passes through;
      // only proxy-controlled breakpoints exist in the final payload.
      walkCacheControl(wire, () => undefined)
      addToolsAndSystemCacheControl(wire)
      break
    }
  }
}

function addToolsAndSystemCacheControl(wire: Record<string, unknown>): void {
  let remaining = CACHE_CONTROL_BREAKPOINT_LIMIT - countExistingCacheBreakpoints(wire)
  if (remaining <= 0) return

  const toolResult = addToolCacheControl(wire.tools as Array<Tool> | undefined, remaining)
  if (toolResult.changed) {
    wire.tools = toolResult.tools
    remaining = toolResult.remaining
  }

  if (remaining <= 0) return

  const systemResult = addSystemCacheControl(wire.system as MessagesPayload["system"], remaining)
  if (systemResult.changed) {
    wire.system = systemResult.system
  }
}

function countExistingCacheBreakpoints(wire: Record<string, unknown>): number {
  return (
    countCacheControlOccurrences(wire.messages)
    + countCacheControlOccurrences(wire.system)
    + countCacheControlOccurrences(wire.tools)
  )
}

function countCacheControlOccurrences(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((count: number, item): number => count + countCacheControlOccurrences(item), 0)
  }

  if (!value || typeof value !== "object") {
    return 0
  }

  const record = value as Record<string, unknown>
  let count = record.cache_control ? 1 : 0

  for (const nested of Object.values(record)) {
    if (nested !== record.cache_control) {
      count += countCacheControlOccurrences(nested)
    }
  }

  return count
}

function addToolCacheControl(
  tools: Array<Tool> | undefined,
  remaining: number,
): { tools: Array<Tool> | undefined; remaining: number; changed: boolean } {
  if (!tools || remaining <= 0) {
    return { tools, remaining, changed: false }
  }

  const lastNonDeferredIndex = findLastIndex(tools, (tool) => tool.defer_loading !== true)
  if (lastNonDeferredIndex < 0 || tools[lastNonDeferredIndex].cache_control) {
    return { tools, remaining, changed: false }
  }

  const updatedTools = [...tools]
  updatedTools[lastNonDeferredIndex] = {
    ...updatedTools[lastNonDeferredIndex],
    cache_control: EPHEMERAL_CACHE_CONTROL,
  }
  return { tools: updatedTools, remaining: remaining - 1, changed: true }
}

function addSystemCacheControl(
  system: MessagesPayload["system"] | undefined,
  remaining: number,
): { system: MessagesPayload["system"] | undefined; changed: boolean } {
  if (!Array.isArray(system) || remaining <= 0) {
    return { system, changed: false }
  }

  const lastSystemIndex = system.length - 1
  if (lastSystemIndex < 0 || system[lastSystemIndex].cache_control) {
    return { system, changed: false }
  }

  const updatedSystem = [...system]
  updatedSystem[lastSystemIndex] = {
    ...updatedSystem[lastSystemIndex],
    cache_control: EPHEMERAL_CACHE_CONTROL,
  }
  return { system: updatedSystem, changed: true }
}

function findLastIndex<T>(items: Array<T>, predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) {
      return index
    }
  }

  return -1
}

/**
 * Walk all cache_control occurrences in the wire payload (system, messages, tools)
 * and apply a handler. The handler receives the existing cache_control value and returns:
 * - undefined: delete the cache_control field
 * - an object: replace the cache_control field with this value
 */
function walkCacheControl(
  wire: Record<string, unknown>,
  handler: (current: unknown) => { type: string } | undefined,
): void {
  for (const key of ["system", "messages", "tools"] as const) {
    if (Array.isArray(wire[key])) {
      walkCacheControlArray(wire[key] as Array<Record<string, unknown>>, handler)
    }
  }
}

function walkCacheControlArray(
  items: Array<Record<string, unknown>>,
  handler: (current: unknown) => { type: string } | undefined,
): void {
  for (const item of items) {
    if (!item || typeof item !== "object") continue

    if ("cache_control" in item && item.cache_control) {
      const replacement = handler(item.cache_control)
      if (replacement === undefined) {
        delete item.cache_control
      } else {
        item.cache_control = replacement
      }
    }

    // Recurse into content arrays (message.content, tool_result.content)
    if (Array.isArray(item.content)) {
      walkCacheControlArray(item.content as Array<Record<string, unknown>>, handler)
    }
  }
}
