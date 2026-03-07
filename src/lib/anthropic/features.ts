/**
 * Anthropic model feature detection and request header construction.
 *
 * Mirrors VSCode Copilot Chat's feature detection logic from:
 * - anthropic.ts: modelSupportsInterleavedThinking, modelSupportsContextEditing, modelSupportsToolSearch
 * - chatEndpoint.ts: getExtraHeaders (anthropic-beta, capi-beta-1)
 * - anthropic.ts: buildContextManagement
 */

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
