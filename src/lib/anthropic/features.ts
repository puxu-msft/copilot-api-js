/**
 * Anthropic model feature detection and request header construction.
 *
 * Mirrors VSCode Copilot Chat's feature detection logic from:
 * - anthropic.ts: modelSupportsInterleavedThinking, modelSupportsContextEditing
 *   (tool search lives upstream as isAnthropicToolSearchEnabled + the
 *   TOOL_SEARCH_SUPPORTED_MODELS constant; mirrored here as modelSupportsToolSearch)
 * - chatEndpoint.ts: getExtraHeaders (anthropic-beta headers)
 * - anthropic.ts: buildContextManagement
 */

import type { Model } from "~/lib/models/client"
import type { ContextEditingMode } from "~/lib/state"

import {
  //
  ENDPOINT,
  isEndpointSupported,
} from "~/lib/models/endpoint"
import { normalizeForMatching } from "~/lib/models/resolver"
import { state } from "~/lib/state"

// ============================================================================
// API routing
// ============================================================================

export interface ApiRoutingDecision {
  supported: boolean
  reason: string
}

/**
 * Check if a model supports direct Anthropic API.
 * Returns a decision with reason so callers can log/display the routing rationale.
 */
export function supportsDirectAnthropicApi(modelId: string): ApiRoutingDecision {
  const model = state.modelIndex.get(modelId)
  if (model?.vendor !== "Anthropic") {
    return { supported: false, reason: `vendor is "${model?.vendor ?? "unknown"}", not Anthropic` }
  }

  if (!isEndpointSupported(model, ENDPOINT.MESSAGES)) {
    return { supported: false, reason: "model does not support /v1/messages endpoint" }
  }

  return { supported: true, reason: "Anthropic vendor with /v1/messages support" }
}

// ============================================================================
// Model Feature Detection
// ============================================================================

/**
 * Interleaved thinking is supported by:
 * - Claude Sonnet 4/4.5
 * - Claude Haiku 4.5
 * - Claude Opus 4.5
 *
 * Notably:
 * - claude-opus-4 and claude-opus-4-1 do NOT support interleaved thinking
 * - claude-opus-4-6 uses adaptive thinking (not interleaved); see
 *   modelHasAdaptiveThinking() for the runtime decision that drives the
 *   interleaved-thinking beta header.
 */
export function modelSupportsInterleavedThinking(modelId: string): boolean {
  const normalized = normalizeForMatching(modelId)
  return (
    normalized.startsWith("claude-sonnet-4-5")
    || normalized.startsWith("claude-sonnet-4")
    || normalized.startsWith("claude-haiku-4-5")
    || normalized.startsWith("claude-opus-4-5")
  )
}

/**
 * Context editing is supported by a broader set of models:
 * - Claude Haiku 4.5
 * - Claude Sonnet 4/4.5/4.6
 * - Claude Opus 4/4.1/4.5/4.6/4.7
 */
export function modelSupportsContextEditing(modelId: string): boolean {
  const normalized = normalizeForMatching(modelId)
  return (
    normalized.startsWith("claude-haiku-4-5")
    || normalized.startsWith("claude-sonnet-4-6")
    || normalized.startsWith("claude-sonnet-4-5")
    || normalized === "claude-sonnet-4"
    || normalized.startsWith("claude-opus-4-7")
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
 * - Claude Opus 4.5/4.6/4.7
 */
export function modelSupportsToolSearch(modelId: string): boolean {
  const normalized = normalizeForMatching(modelId)
  return (
    normalized.startsWith("claude-sonnet-4-5")
    || normalized.startsWith("claude-sonnet-4-6")
    || normalized.startsWith("claude-opus-4-5")
    || normalized.startsWith("claude-opus-4-6")
    || normalized.startsWith("claude-opus-4-7")
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
 * Check if a model supports adaptive thinking.
 *
 * Models with adaptive thinking (e.g. opus 4.6/4.7/4.8) use `thinking: { type: 'adaptive' }`
 * and do NOT need the interleaved-thinking beta header. Models without adaptive
 * thinking still need the beta header to enable interleaved thinking.
 *
 * Detection precedence:
 *   1. Metadata `supports.adaptive_thinking === true` → adaptive.
 *   2. Positive enabled-thinking signal: `supports.max_thinking_budget > 0`
 *      without an adaptive flag means the model declares budget-based (enabled)
 *      thinking — trust that and report NOT adaptive. Predictive normalization
 *      must not override a positive metadata signal; if the upstream still
 *      rejects `enabled`, the reactive `legacy-thinking-retry` strategy converts.
 *   3. Metadata silent (no thinking fields): fall back to a model-name allowlist,
 *      mirroring modelSupportsToolSearch / modelSupportsContextEditing. This
 *      fills the gap when an upstream `/models` payload lags a new release.
 *
 * The beta-header decision shares this function, so a false result (cases 2/3
 * fall-through) keeps interleaved-thinking — harmless if the model is in fact
 * adaptive (the server ignores unknown betas).
 */
export function modelHasAdaptiveThinking(modelId: string, resolvedModel?: Model): boolean {
  const supports = resolvedModel?.capabilities?.supports
  if (supports?.adaptive_thinking === true) return true
  // Positive enabled-thinking declaration → respect metadata, don't name-fallback.
  if (typeof supports?.max_thinking_budget === "number" && supports.max_thinking_budget > 0) return false

  const normalized = normalizeForMatching(modelId)
  return normalized.startsWith("claude-opus-4-6") || normalized.startsWith("claude-opus-4-7") || normalized.startsWith("claude-opus-4-8")
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
export function buildAnthropicBetaHeaders(modelId: string, resolvedModel?: Model, opts?: AnthropicBetaHeaderOptions): AnthropicBetaHeaders {
  const headers: AnthropicBetaHeaders = {}
  const betaFeatures: Array<string> = []

  // Adaptive thinking models (e.g. opus 4.6/4.7/4.8) don't need the interleaved-thinking beta.
  // All other models that support interleaved thinking need it explicitly enabled.
  if (!modelHasAdaptiveThinking(modelId, resolvedModel)) {
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

/**
 * Merge client-sent `anthropic-beta` with locally-built beta features.
 *
 * The client may send its own beta features (e.g. from Anthropic SDK — extended
 * cache TTL, token counting, etc.) that our feature-detection layer doesn't know
 * about. Overwriting would drop those betas; merging preserves both sources.
 *
 * Mirrors VSCode Copilot Chat's fix in #4945 (ClaudeStreamingPassThroughEndpoint).
 *
 * @returns merged comma-separated string, or undefined if both inputs are empty
 */
export function mergeAnthropicBeta(clientBeta: string | undefined, localBeta: string | undefined): string | undefined {
  const merged = new Set<string>()
  for (const source of [clientBeta, localBeta]) {
    if (!source) continue
    for (const value of source.split(",")) {
      const trimmed = value.trim()
      if (trimmed) merged.add(trimmed)
    }
  }
  return merged.size > 0 ? [...merged].join(",") : undefined
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

  const triggerValue = state.contextEditingTrigger
  const keepCount = state.contextEditingKeepTools
  const thinkingKeepTurns = state.contextEditingKeepThinking

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
      trigger: { type: "input_tokens", value: triggerValue },
      keep: { type: "tool_uses", value: keepCount },
    })
  }

  return edits.length > 0 ? { edits } : undefined
}
