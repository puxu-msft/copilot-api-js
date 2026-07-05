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

import { findMostSpecific } from "./per-model-config"

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
 * Match a model against a config-driven capability allowlist of model-name "family" prefixes.
 *
 * A prefix `p` matches when `normalize(x) === normalize(p)` OR `normalize(x)` starts with
 * `normalize(p) + "-"`, for `x` in {modelId, family}. The trailing-dash boundary is what makes
 * `claude-opus-4` match the bare `claude-opus-4` and the whole `claude-opus-4-x` family, WITHOUT
 * matching the unrelated `claude-opus-40`. Entries may be written dotted or dashed (both normalize
 * the same). The lists live in `state` (sourced from `anthropic.model_capabilities` in config.yaml —
 * bundled defaults mirror GHC's capability checks); editing config adds/removes models without a code change.
 *
 * The optional `family` mirrors GHC's `matches(id) || matches(family)` (chatModelCapabilities.ts /
 * anthropic.ts): a model whose resolved id normalizes to a denied form but whose family is an allowed
 * Claude family still lights the capability up. Our dash boundary is intentionally stricter than GHC's
 * bare `startsWith` (GHC's `claude-opus-40` would match `claude-opus-4`; ours does not) — a deliberate,
 * more-correct divergence that avoids prefix-accident false positives.
 */
function matchModelCapability(modelId: string, prefixes: ReadonlyArray<string>, family?: string): boolean {
  const candidates = family ? [normalizeForMatching(modelId), normalizeForMatching(family)] : [normalizeForMatching(modelId)]
  return prefixes.some((p) => {
    const np = normalizeForMatching(p)
    return candidates.some((n) => n === np || n.startsWith(`${np}-`))
  })
}

/**
 * Read a boolean capability flag the model DECLARES in its `/models` metadata (`capabilities.
 * supports.<key>`). Returns `undefined` when absent/non-boolean so the caller can `?? ` to the
 * config name-list — the GHC-faithful "metadata-first, name-fallback" layering (chatEndpoint.ts:
 * `supports.context_editing ?? modelSupportsContextEditing(this)`). The Copilot `/models` does NOT
 * currently expose `context_editing` / `tool_search` (only `adaptive_thinking`), so today this is
 * always `undefined` for them and the name-list wins — but honoring the flag the moment GHC adds it
 * keeps the proxy aligned with upstream without a code change.
 */
function metadataCapability(resolvedModel: Model | undefined, key: string): boolean | undefined {
  const v = resolvedModel?.capabilities?.supports?.[key]
  return typeof v === "boolean" ? v : undefined
}

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
export function modelSupportsInterleavedThinking(modelId: string, resolvedModel?: Model): boolean {
  return matchModelCapability(modelId, state.interleavedThinkingModels, resolvedModel?.capabilities?.family)
}

/**
 * Context editing is supported by a broader set of models:
 * - Claude Haiku 4.5
 * - Claude Sonnet 4/4.5/4.6
 * - Claude Opus 4/4.1/4.5/4.6/4.7
 */
export function modelSupportsContextEditing(modelId: string, resolvedModel?: Model): boolean {
  // Metadata-first (GHC-faithful): honor the model's declared `supports.context_editing`, else the
  // config-driven name allowlist. Mirrors chatEndpoint.ts `supports.context_editing ?? modelSupports…`.
  return metadataCapability(resolvedModel, "context_editing") ?? matchModelCapability(modelId, state.contextEditingModels, resolvedModel?.capabilities?.family)
}

/**
 * Check if context editing is enabled for a model.
 * Requires both model support AND config mode != 'off'.
 * Mirrors VSCode Copilot Chat's isAnthropicContextEditingEnabled().
 */
export function isContextEditingEnabled(modelId: string, resolvedModel?: Model): boolean {
  return modelSupportsContextEditing(modelId, resolvedModel) && state.contextEditingMode !== "off"
}

/**
 * Built-in default-allow tool-search matcher, mirroring GHC's `modelSupportsToolSearch`
 * (chatModelCapabilities.ts): every current-generation Claude (4.5 and newer) supports tool search,
 * so new/future Claude models are picked up automatically; Haiku (no support) and the pre-4.5
 * generations are denied explicitly. GHC's OpenAI gpt-5.4/5.5 branch is intentionally NOT mirrored —
 * this module only runs on the Anthropic path.
 *
 * Uses raw `startsWith` on the normalized name (matching GHC), so the pre-4.5 datestamped bases
 * (`claude-sonnet-4-20250514` → normalizes to `…-4-2…`) are correctly denied, while `claude-opus-40`
 * is ALLOWED (GHC parity: not `=== claude-opus-4`, not a `-4-1`/`-4-2` prefix). Checks id AND family.
 */
export function toolSearchDefaultAllow(modelId: string, family?: string): boolean {
  const check = (raw: string): boolean => {
    const n = normalizeForMatching(raw)
    if (!n.startsWith("claude")) return false
    // Haiku has no tool-search support — deny explicitly.
    if (n.startsWith("claude-haiku")) return false
    // Pre-4.5 Claude generations are unsupported; everything newer is allowed automatically. The
    // `-4-2` prefixes also catch the datestamped 4.0 bases (e.g. `claude-sonnet-4-20250514`).
    const isPre45 =
      n.startsWith("claude-1")
      || n.startsWith("claude-2")
      || n.startsWith("claude-3")
      || n.startsWith("claude-instant")
      || n === "claude-sonnet-4"
      || n.startsWith("claude-sonnet-4-2")
      || n === "claude-opus-4"
      || n.startsWith("claude-opus-4-1")
      || n.startsWith("claude-opus-4-2")
    return !isPre45
  }
  return check(modelId) || (family !== undefined && check(family))
}

/**
 * Tool search is default-allow for Claude ≥4.5 (Haiku + pre-4.5 denied); see {@link toolSearchDefaultAllow}.
 *
 * Precedence (each layer is authoritative when it resolves): declared metadata `supports.tool_search`,
 * then the config-driven per-model `tool_search_overrides` force-on/off map (most-specific / `"*"`
 * wildcard), then the built-in default-allow matcher. A `false` at any layer force-disables. This is a
 * PURE capability predicate — the `toolSearchEnabled` master switch gates CONSUMPTION at the call sites
 * (beta header + tool-pipeline injection), not the predicate, so metadata-consistency holds.
 */
export function modelSupportsToolSearch(modelId: string, resolvedModel?: Model): boolean {
  return (
    metadataCapability(resolvedModel, "tool_search")
    ?? findMostSpecific(modelId, state.toolSearchOverrides)
    ?? toolSearchDefaultAllow(modelId, resolvedModel?.capabilities?.family)
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
  /**
   * Force the `context-management-2025-06-27` beta even when `isContextEditingEnabled` is false
   * (mode off). Set by L2 escalation, which force-injects a `context_management` body regardless
   * of mode — the body without its beta header would 400 upstream.
   */
  forceContextManagementBeta?: boolean
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
  return matchModelCapability(normalized, state.adaptiveThinkingModels, resolvedModel?.capabilities?.family)
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

  if (!opts?.disableContextManagement && (isContextEditingEnabled(modelId, resolvedModel) || opts?.forceContextManagementBeta)) {
    betaFeatures.push("context-management-2025-06-27")
  }

  // The `toolSearchEnabled` master switch is the single gate for tool-search (beta header AND the
  // tool-pipeline injection in message-tools.ts), keeping the header consistent with the pipeline.
  if (state.toolSearchEnabled && modelSupportsToolSearch(modelId, resolvedModel)) {
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
export function buildContextManagement(
  mode: ContextEditingMode,
  hasThinking: boolean,
  escalation?: { trigger: number; keepTools: number; keepThinking: number },
): ContextManagement | undefined {
  // L2 escalation (RFC §8): FORCE an aggressive clear_tool_uses (+ clear_thinking when thinking is
  // present) regardless of `mode` — a retry-only emergency compression to finish faster before the
  // next RST. The caller gates model support (contextManagementDisabled); this only shapes the edit.
  if (escalation) {
    const edits: Array<ContextManagementEdit> = []
    if (hasThinking) {
      edits.push({ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: Math.max(1, escalation.keepThinking) } })
    }
    edits.push({
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: Math.max(1, escalation.trigger) },
      keep: { type: "tool_uses", value: Math.max(0, escalation.keepTools) },
    })
    return { edits }
  }

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
