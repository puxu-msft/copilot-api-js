/**
 * Anthropic model feature detection and request header construction.
 *
 * Mirrors VSCode Copilot Chat's feature detection logic from:
 * - anthropic.ts: modelSupportsInterleavedThinking, modelSupportsContextEditing, modelSupportsToolSearch
 * - chatEndpoint.ts: getExtraHeaders (anthropic-beta headers)
 * - anthropic.ts: buildContextManagement
 */

import type { Model } from "~/lib/models/client"
import type { ContextEditingMode } from "~/lib/state"

import { normalizeForMatching } from "~/lib/models/resolver"
import { state } from "~/lib/state"

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
 * - Claude Sonnet 4/4.5/4.6
 * - Claude Opus 4/4.1/4.5/4.6
 */
export function modelSupportsContextEditing(modelId: string): boolean {
  const normalized = normalizeForMatching(modelId)
  return (
    normalized.startsWith("claude-haiku-4-5")
    || normalized.startsWith("claude-sonnet-4-6")
    || normalized.startsWith("claude-sonnet-4-5")
    || normalized === "claude-sonnet-4"
    || normalized.startsWith("claude-opus-4-5")
    || normalized.startsWith("claude-opus-4-6")
    || normalized.startsWith("claude-opus-4-1")
    || normalized === "claude-opus-41"
    || normalized === "claude-opus-4"
  )
}

/**
 * Check if context editing is enabled for a model.
 * Requires both model support AND config mode != 'off'.
 * Mirrors VSCode Copilot Chat's isAnthropicContextEditingEnabled().
 */
export function isContextEditingEnabled(modelId: string): boolean {
  return modelSupportsContextEditing(modelId) && state.contextEditingMode !== "off"
}

/**
 * Tool search is supported by:
 * - Claude Sonnet 4.5/4.6
 * - Claude Opus 4.5/4.6
 */
export function modelSupportsToolSearch(modelId: string): boolean {
  const normalized = normalizeForMatching(modelId)
  return (
    normalized.startsWith("claude-sonnet-4-5")
    || normalized.startsWith("claude-sonnet-4-6")
    || normalized.startsWith("claude-opus-4-5")
    || normalized.startsWith("claude-opus-4-6")
  )
}

// ============================================================================
// Anthropic Beta Headers
// ============================================================================

export interface AnthropicBetaHeaders {
  /** Comma-separated beta feature identifiers */
  "anthropic-beta"?: string
}

export interface AnthropicBetaHeaderOptions {
  disableContextManagement?: boolean
}

/**
 * Check if a model supports adaptive thinking (from model metadata).
 *
 * Models with adaptive thinking (e.g. opus 4.6) use `thinking: { type: 'adaptive' }`
 * and do NOT need the interleaved-thinking beta header. Models without adaptive
 * thinking still need the beta header to enable interleaved thinking.
 *
 * Uses model metadata `capabilities.supports.adaptive_thinking` field.
 * Falls back to false when metadata is unavailable, which is safe because
 * adding the interleaved-thinking beta to an adaptive model is harmless
 * (the server ignores unknown betas), while omitting it from a non-adaptive
 * model that needs it would break thinking.
 */
function modelHasAdaptiveThinking(resolvedModel?: Model): boolean {
  return resolvedModel?.capabilities?.supports?.adaptive_thinking === true
}

/**
 * Build anthropic-beta headers based on model capabilities.
 *
 * Logic from chatEndpoint.ts:getExtraHeaders:
 * - If model does NOT support adaptive thinking → add "interleaved-thinking-2025-05-14"
 * - If model supports context editing → add "context-management-2025-06-27"
 * - If model supports tool search → add "advanced-tool-use-2025-11-20"
 *
 * The resolvedModel parameter provides model metadata for capability-based
 * decisions. When unavailable, falls back to name-based detection.
 */
export function buildAnthropicBetaHeaders(
  modelId: string,
  resolvedModel?: Model,
  opts?: AnthropicBetaHeaderOptions,
): AnthropicBetaHeaders {
  const headers: AnthropicBetaHeaders = {}
  const betaFeatures: Array<string> = []

  // Adaptive thinking models (e.g. opus 4.6) don't need the interleaved-thinking beta.
  // All other models that support interleaved thinking need it explicitly enabled.
  if (!modelHasAdaptiveThinking(resolvedModel)) {
    betaFeatures.push("interleaved-thinking-2025-05-14")
  }

  if (!opts?.disableContextManagement && isContextEditingEnabled(modelId)) {
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
 *
 * Only builds edits matching the requested mode:
 * - "off" → undefined (no context management)
 * - "clear-thinking" → clear_thinking only (if thinking is enabled)
 * - "clear-tooluse" → clear_tool_uses only
 * - "clear-both" → both edits
 */
export function buildContextManagement(mode: ContextEditingMode, hasThinking: boolean): ContextManagement | undefined {
  if (mode === "off") {
    return undefined
  }

  // Default config from getContextManagementFromConfig
  const triggerType = "input_tokens"
  const triggerValue = 100_000
  const keepCount = 3
  const thinkingKeepTurns = 1

  const edits: Array<ContextManagementEdit> = []

  // Add clear_thinking when mode is "clear-thinking" or "clear-both", and thinking is enabled
  if ((mode === "clear-thinking" || mode === "clear-both") && hasThinking) {
    edits.push({
      type: "clear_thinking_20251015",
      keep: { type: "thinking_turns", value: Math.max(1, thinkingKeepTurns) },
    })
  }

  // Add clear_tool_uses when mode is "clear-tooluse" or "clear-both"
  if (mode === "clear-tooluse" || mode === "clear-both") {
    edits.push({
      type: "clear_tool_uses_20250919",
      trigger: { type: triggerType, value: triggerValue },
      keep: { type: "tool_uses", value: keepCount },
    })
  }

  return edits.length > 0 ? { edits } : undefined
}
