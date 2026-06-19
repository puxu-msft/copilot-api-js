import consola from "consola"

import type { Model } from "~/lib/models/client"

import { copilotHeaders } from "~/lib/copilot-api"
import { state } from "~/lib/state"
import {
  //
  type MessagesPayload,
  type OutputConfig,
  type Tool,
  EFFORT_LEVELS,
} from "~/types/api/anthropic"

import {
  //
  getSupportedEfforts,
  getUnsupportedFeatures,
  isAnthropicBetaUnsupported,
  isAnthropicFeatureUnsupported,
  setSupportedEfforts,
} from "./feature-negotiation"
import {
  //
  buildAnthropicBetaHeaders,
  buildContextManagement,
  isContextEditingEnabled,
  mergeAnthropicBeta,
  modelHasAdaptiveThinking,
} from "./features"
import { stripServerTools } from "./message-tools"
import {
  //
  collectAllMatching,
  findMostSpecific,
} from "./per-model-config"

export interface PreparedAnthropicRequest {
  wire: Record<string, unknown>
  headers: Record<string, string>
}

/**
 * The mutable prepare context threaded through the prepare steps: the wire body
 * (built from the payload, then trimmed/clamped in place), the accumulating
 * headers, and the per-attempt options (resolvedModel + PrepareHints).
 */
export interface PrepareContext {
  wire: Record<string, unknown>
  headers: Record<string, string>
  opts: PrepareAnthropicRequestOptions
}

/** One named prepare step. Mutates `ctx.wire` and/or `ctx.headers` in place. */
export interface PrepareStep {
  readonly name: string
  apply(ctx: PrepareContext): void
}

interface PrepareAnthropicRequestOptions {
  resolvedModel?: Model
  /**
   * Client-sent `anthropic-beta` header (raw comma-separated string).
   * Merged with locally-built beta features so SDK-provided betas survive.
   * Mirrors GHC #4945 fix.
   */
  clientAnthropicBeta?: string
  /**
   * Per-attempt overrides supplied by retry strategies (see PrepareHints in
   * lib/request/pipeline.ts). These are unioned with the persistent
   * negotiation cache results during filtering, so the retry caller gets
   * deterministic exclusion of THIS attempt without depending on the cache
   * having been written by a prior strategy.
   */
  excludeBetas?: ReadonlyArray<string>
  rejectFields?: ReadonlyArray<string>
  /**
   * Server tool type prefixes to strip from the next wire payload, in addition
   * to anything the global config / negotiation cache already strips. Supplied
   * by the server-tool-rejection retry strategy via
   * `PrepareHints.excludeServerToolTypes`.
   */
  excludeServerToolTypes?: ReadonlyArray<string>
}

/**
 * Built-in body fields the Copilot upstream historically rejects.
 * Merged with config `rejectBodyFields` (per-model) and runtime-learned
 * negotiation cache entries.
 */
const BUILTIN_REJECTED_FIELDS: ReadonlyArray<string> = ["inference_geo"]
const CACHE_CONTROL_BREAKPOINT_LIMIT = 4
const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const

/**
 * Collect the full set of body fields to strip for `modelName`:
 *   - built-in defaults (e.g. inference_geo)
 *   - config-sourced `anthropic.reject_body_fields` (per-model substring, `"*"` = all)
 *   - runtime-learned negotiation cache (per-(endpoint, model))
 *
 * Use `getUnsupportedFeatures(model)` rather than per-field probing so this
 * stays O(1) over the negotiation map size.
 */
function collectRejectedFields(modelName: string): Set<string> {
  const reject = new Set<string>(BUILTIN_REJECTED_FIELDS)
  for (const fields of collectAllMatching(modelName, state.rejectBodyFields)) {
    for (const field of fields) reject.add(field)
  }
  for (const field of getUnsupportedFeatures(modelName)) reject.add(field)
  return reject
}

/**
 * Return the set of beta tokens that should be stripped for `modelName`,
 * combining config-sourced `stripBetaHeaders` and runtime-learned entries.
 * The pseudo-key `"*"` in config applies to every model.
 */
function collectStripBetas(modelName: string): Set<string> {
  const strip = new Set<string>()
  for (const tokens of collectAllMatching(modelName, state.stripBetaHeaders)) {
    for (const token of tokens) strip.add(token)
  }
  return strip
}

/**
 * Drop beta tokens that are known-unsupported for `modelName`. Returns the
 * filtered comma-separated header value, or `undefined` if nothing remains.
 *
 * Filter sources, unioned:
 *   - Config `stripBetaHeaders` (per-model + wildcard "*")
 *   - Persistent negotiation cache (runtime-learned across requests)
 *   - `excludeBetas` — per-attempt hint passed from a retry strategy via
 *     `PrepareHints.excludeBetas`. Makes intra-retry exclusion deterministic
 *     without depending on cache having been written.
 */
export function filterUnsupportedBetas(modelName: string, merged: string | undefined, excludeBetas?: ReadonlyArray<string>): string | undefined {
  if (!merged) return undefined
  const configStrip = collectStripBetas(modelName)
  const hintStrip = new Set(excludeBetas ?? [])
  const kept: Array<string> = []
  const dropped: Array<string> = []
  for (const raw of merged.split(",")) {
    const token = raw.trim()
    if (!token) continue
    if (configStrip.has(token) || hintStrip.has(token) || isAnthropicBetaUnsupported(modelName, token)) {
      dropped.push(token)
      continue
    }
    kept.push(token)
  }
  if (dropped.length > 0) {
    consola.debug(`[DirectAnthropic] Stripped unsupported beta(s) for ${modelName}: ${dropped.join(", ")}`)
  }
  return kept.length > 0 ? kept.join(",") : undefined
}

/**
 * Build the request headers from the prepared wire body (B7–B12). Kept cohesive
 * as one step: `contextManagementDisabled` gates the context_management body
 * delete, the beta-header build, AND the context_management auto-injection, and
 * the beta sub-pipeline (build → merge → filter) threads a single local value —
 * splitting them would scatter that shared intermediate state (the same honest
 * in-step coupling as sanitize's A6<A8). Reads ctx.wire + ctx.opts, writes
 * ctx.headers (and may add/remove ctx.wire.context_management).
 */
function buildAnthropicHeaders(ctx: PrepareContext): void {
  const { wire, opts } = ctx
  const model = wire.model as string
  const messages = wire.messages as MessagesPayload["messages"]
  const thinking = wire.thinking as MessagesPayload["thinking"]

  const enableVision = messages.some((msg) => {
    if (typeof msg.content === "string") return false
    return msg.content.some((block) => block.type === "image")
  })

  const isAgentCall = messages.some((msg) => msg.role === "assistant")
  const modelSupportsVision = opts.resolvedModel?.capabilities?.supports?.vision !== false
  // context_management body field is stripped by buildWirePayload when the negotiation
  // cache or rejectBodyFields config marks it unsupported. We also need to suppress
  // the matching beta header and any subsequent auto-injection by the contextEditingMode
  // logic. The signal source is the negotiation cache (config-driven strip implies
  // the operator already knows it's unsupported but is independent of the cache).
  const contextManagementDisabled = wire.context_management === null || isAnthropicFeatureUnsupported(model, "context_management")

  if (contextManagementDisabled) {
    delete wire.context_management
  }

  const localBeta = buildAnthropicBetaHeaders(model, opts.resolvedModel, {
    disableContextManagement: contextManagementDisabled,
  })
  const mergedBeta = mergeAnthropicBeta(opts.clientAnthropicBeta, localBeta["anthropic-beta"])
  const filteredBeta = filterUnsupportedBetas(model, mergedBeta, opts.excludeBetas)

  const headers: Record<string, string> = {
    ...copilotHeaders(state, {
      vision: enableVision && modelSupportsVision,
      modelRequestHeaders: opts.resolvedModel?.request_headers,
      intent: isAgentCall ? "conversation-agent" : "conversation-panel",
    }),
    "X-Initiator": isAgentCall ? "agent" : "user",
    "anthropic-version": "2023-06-01",
  }
  if (filteredBeta) headers["anthropic-beta"] = filteredBeta

  if (!contextManagementDisabled && !("context_management" in wire) && isContextEditingEnabled(model)) {
    const hasThinking = Boolean(thinking && thinking.type !== "disabled")
    const contextManagement = buildContextManagement(state.contextEditingMode, hasThinking)
    if (contextManagement) {
      wire.context_management = contextManagement
      consola.debug("[DirectAnthropic] Added context_management:", JSON.stringify(contextManagement))
    }
  }

  ctx.headers = headers
}

/**
 * The Anthropic prepare pipeline — a FIXED ordered list of named steps (B3–B12).
 * Unlike the S3 request rewrites (which filter via appliesTo + sort), prepare is
 * an unfiltered fixed sequence: every step always runs and self-gates on config/
 * model internally, so declaration order IS the contract (no order keys / sort).
 * B1+B2 (buildWirePayload: reject-field strip + server-tool strip) is the ctx
 * initializer that creates the wire the steps mutate.
 *
 * Thinking transforms keep their fixed order (B3<B4<B5): coerce the SHAPE first
 * (enabled→adaptive for adaptive-only models), then clamp the budget (a no-op
 * once adaptive), then clamp the effort against the model whitelist — so an
 * out-of-range value coerceAdaptiveThinking maps can't reach upstream.
 */
export const ANTHROPIC_PREPARE_STEPS: ReadonlyArray<PrepareStep> = [
  { name: "coerce-thinking", apply: (ctx) => coerceAdaptiveThinking(ctx.wire, ctx.opts.resolvedModel) },
  { name: "adjust-budget", apply: (ctx) => adjustThinkingBudget(ctx.wire, ctx.opts.resolvedModel) },
  { name: "clamp-effort", apply: (ctx) => clampEffortLevel(ctx.wire, ctx.opts.resolvedModel) },
  { name: "cache-control", apply: (ctx) => applyCacheControlMode(ctx.wire) },
  { name: "build-headers", apply: buildAnthropicHeaders },
]

/**
 * Derive the final wire (body + headers) for one upstream attempt. Initializes
 * the prepare context from the payload (buildWirePayload = B1+B2) then runs the
 * ordered prepare steps. Called per-attempt — PrepareHints in opts (excludeBetas
 * / rejectFields) vary per retry.
 *
 * `steps` defaults to {@link ANTHROPIC_PREPARE_STEPS}; the param is a DI seam for
 * tests (assert the runner iterates the list) and P2's driver (which assembles
 * the prepareWire chain and feeds per-step `request.rewrite_applied` events).
 */
export function prepareAnthropicRequest(
  payload: MessagesPayload,
  opts?: PrepareAnthropicRequestOptions,
  steps: ReadonlyArray<PrepareStep> = ANTHROPIC_PREPARE_STEPS,
): PreparedAnthropicRequest {
  const ctx: PrepareContext = {
    wire: buildWirePayload(payload, opts?.rejectFields, opts?.excludeServerToolTypes),
    headers: {},
    opts: opts ?? {},
  }
  for (const step of steps) step.apply(ctx)
  return { wire: ctx.wire, headers: ctx.headers }
}

function buildWirePayload(
  payload: MessagesPayload,
  rejectFields?: ReadonlyArray<string>,
  excludeServerToolTypes?: ReadonlyArray<string>,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {}
  const rejected = collectRejectedFields(payload.model)
  if (rejectFields) {
    for (const f of rejectFields) rejected.add(f)
  }
  const rejectedFields: Array<string> = []

  // Fields that prepare-time transforms (applyCacheControlMode,
  // stripServerTools, clampEffortLevel, adjustThinkingBudget, etc.) mutate
  // via walkCacheControlArray, direct splice, or property assignment.
  // Without deep-cloning these into the wire object, the mutations leak back
  // into the caller's payload — and on retry, the next prep step sees an
  // already-stripped / already-clamped payload, accumulating losses across
  // attempts.
  //
  // Add to this set whenever a new mutate-in-place transform targets a
  // nested payload field; the set is the single source of "what wire owns
  // exclusively" so we don't grow an ad-hoc collection of one-off clones.
  const DEEP_CLONE_FIELDS = new Set(["messages", "system", "tools", "output_config", "thinking"])

  for (const [key, value] of Object.entries(payload)) {
    if (rejected.has(key)) {
      rejectedFields.push(key)
    } else if (DEEP_CLONE_FIELDS.has(key) && value !== undefined && value !== null) {
      wire[key] = structuredClone(value)
    } else {
      wire[key] = value
    }
  }

  if (rejectedFields.length > 0) {
    consola.debug(`[DirectAnthropic] Stripped rejected fields: ${rejectedFields.join(", ")}`)
  }

  if (wire.tools) {
    wire.tools = stripServerTools(wire.tools as Array<Tool>, payload.model, excludeServerToolTypes)
  }

  return wire
}

// ============================================================================
// Adaptive thinking coercion
// ============================================================================

/**
 * Heuristic mapping from a legacy `budget_tokens` to an effort level.
 *
 * GHC does NOT derive effort from budget (the two are independent dimensions);
 * this is a copilot-api enhancement to preserve the "thinking intensity" intent
 * of old clients that only had `budget_tokens` to express it. Thresholds carry
 * no semantic guarantee — they are an opt-in best effort (config
 * `anthropic.coerce_adaptive_thinking: best_effort`).
 *
 * Only low/medium/high are produced (GHC's construction side accepts only these
 * three); clampEffortLevel later fits the value to the model's actual whitelist.
 */
const EFFORT_BUDGET_THRESHOLDS = [
  { maxBudget: 8_192, effort: "low" },
  { maxBudget: 24_576, effort: "medium" },
] as const

function budgetToEffort(budget?: number): "low" | "medium" | "high" | undefined {
  if (typeof budget !== "number" || budget <= 0) return undefined
  for (const threshold of EFFORT_BUDGET_THRESHOLDS) {
    if (budget <= threshold.maxBudget) return threshold.effort
  }
  return "high"
}

/**
 * Coerce a legacy `thinking: { type: "enabled", budget_tokens }` to
 * `{ type: "adaptive" }` when the target model only supports adaptive thinking.
 *
 * Old clients (e.g. older Claude Code CLI) send the pre-adaptive shape, which
 * adaptive-only models (opus 4.6/4.7/4.8) reject with HTTP 400
 * (`"thinking.type.enabled" is not supported for this model`). GHC constructs
 * `{ type: "adaptive" }` (no budget_tokens) for these models, so coercing to
 * the same shape matches the upstream contract.
 *
 * - Only touches `type: "enabled"`; adaptive/disabled are left as-is (no-op).
 * - Gated on modelHasAdaptiveThinking (metadata + name fallback).
 * - Preserves the `display` field (summarized/omitted) for multi-turn signature
 *   continuity.
 * - In `"best_effort"` mode, maps budget_tokens to output_config.effort, but
 *   only when the client did not already send an explicit effort.
 */
function coerceAdaptiveThinking(wire: Record<string, unknown>, resolvedModel?: Model): void {
  if (state.coerceAdaptiveThinking === false) return

  const thinking = wire.thinking as MessagesPayload["thinking"]
  if (!thinking || thinking.type !== "enabled") return

  const model = wire.model as string
  if (!modelHasAdaptiveThinking(model, resolvedModel)) return

  // Map budget→effort BEFORE clampEffortLevel runs, and only when the client did
  // not send an explicit effort (never override the client's intent).
  if (state.coerceAdaptiveThinking === "best_effort") {
    const outputConfig = wire.output_config as OutputConfig | undefined
    if (!outputConfig?.effort) {
      const effort = budgetToEffort(thinking.budget_tokens)
      if (effort) wire.output_config = { ...outputConfig, effort }
    }
  }

  const display = (thinking as { display?: string }).display
  wire.thinking = { type: "adaptive", ...(display ? { display } : {}) }
  consola.debug(`[DirectAnthropic] Coerced legacy thinking enabled→adaptive (model=${model})`)
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
    consola.debug(`[DirectAnthropic] Capped thinking.budget_tokens: ${budgetTokens} → ${adjusted} (max_tokens=${maxTokens})`)
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
 * Dynamically record per-model effort whitelists discovered from upstream
 * `invalid_reasoning_effort` errors. Persisted via the negotiation cache.
 * Config-sourced `effortsOverrides` remains untouched. Returns true if the
 * cache was updated (first-time learn or value changed).
 */
export function learnEffortsFromError(responseText: string): boolean {
  const parsed = parseInvalidEffortError(responseText)
  if (!parsed) return false

  const existing = getSupportedEfforts(parsed.modelName)
  const isFirstLearn = !existing
  const changed = setSupportedEfforts(parsed.modelName, parsed.supported)
  if (!changed) return false

  if (isFirstLearn) {
    consola.info(`[DirectAnthropic] Learned supported efforts for ${parsed.modelName}: [${parsed.supported.join(", ")}]`)
  } else {
    consola.debug(`[DirectAnthropic] Updated supported efforts for ${parsed.modelName}: [${parsed.supported.join(", ")}]`)
  }
  return true
}

/**
 * Find the supported-effort whitelist for a given model name.
 *
 * Priority (highest → lowest):
 *   1. Config-sourced `effortsOverrides` (explicit operator override).
 *      Matched via most-specific key (longest substring); the pseudo-key `"*"`
 *      is a wildcard fallback. Switching from union to most-specific avoids the
 *      bug where a shorter family key (e.g. `claude-opus-4.7`) would shadow a
 *      stricter variant-specific entry (e.g. `claude-opus-4.7-high`).
 *   2. Runtime-learned entries from the negotiation cache (persisted).
 *   3. Model metadata `capabilities.supports.reasoning_effort` (upstream declaration).
 *
 * Reading metadata as a fallback lets us skip the first-round 400 for models
 * that declare effort support upfront (mirrors GHC #5010 precheck), while still
 * allowing operators to override via config when metadata is inaccurate.
 *
 * Cross-validation: when config or learned values include efforts not declared
 * by the model metadata, those out-of-range entries are dropped and warned.
 * Operator intent is preserved for values that ARE in the metadata; only the
 * unsupported tail is trimmed. If the intersection is empty (operator wrote a
 * whitelist that the model rejects entirely), we trust the metadata over the
 * stale config to avoid guaranteed 400s.
 */
export function findSupportedEfforts(modelName: string, resolvedModel?: Model): Array<string> | undefined {
  const rawMetadata = resolvedModel?.capabilities?.supports?.reasoning_effort
  const metadataEfforts = Array.isArray(rawMetadata) && rawMetadata.length > 0 ? rawMetadata : undefined
  const metadataSet = metadataEfforts ? new Set(metadataEfforts) : undefined

  const fromConfig = findMostSpecific(modelName, state.effortsOverrides)
  if (fromConfig && fromConfig.length > 0) {
    return reconcileWithMetadata(fromConfig, metadataSet, modelName, "config")
  }
  const learned = getSupportedEfforts(modelName)
  if (learned && learned.length > 0) {
    return reconcileWithMetadata(learned, metadataSet, modelName, "learned")
  }
  if (metadataEfforts) return metadataEfforts
  return undefined
}

/**
 * Intersect a configured/learned effort whitelist with the model's declared
 * metadata set, logging any out-of-range entries. Returns the intersection
 * when non-empty; otherwise falls back to the metadata list (or the original
 * whitelist if metadata is unavailable).
 */
function reconcileWithMetadata(whitelist: Array<string>, metadataSet: Set<string> | undefined, modelName: string, source: "config" | "learned"): Array<string> {
  if (!metadataSet) return whitelist
  const kept: Array<string> = []
  const dropped: Array<string> = []
  for (const effort of whitelist) {
    if (metadataSet.has(effort)) kept.push(effort)
    else dropped.push(effort)
  }
  if (dropped.length === 0) return whitelist
  if (kept.length === 0) {
    consola.warn(
      `[DirectAnthropic] ${source} effort whitelist for ${modelName} has no overlap with model metadata [${[...metadataSet].join(", ")}]; falling back to metadata. Dropped: [${dropped.join(", ")}]`,
    )
    return [...metadataSet]
  }
  consola.warn(
    `[DirectAnthropic] ${source} effort whitelist for ${modelName} dropped out-of-range values [${dropped.join(", ")}] not in model metadata [${[...metadataSet].join(", ")}]`,
  )
  return kept
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
  const supportedIndices = supported.map((e) => EFFORT_LEVELS.indexOf(e as (typeof EFFORT_LEVELS)[number])).filter((i) => i >= 0)
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
    default: {
      // Exhaustive switch over CacheControlMode union; future modes added to the
      // type must update this switch — `default` is a safety net for runtime
      // values from configs that bypass type checking.
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
  return countCacheControlOccurrences(wire.messages) + countCacheControlOccurrences(wire.system) + countCacheControlOccurrences(wire.tools)
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

function addToolCacheControl(tools: Array<Tool> | undefined, remaining: number): { tools: Array<Tool> | undefined; remaining: number; changed: boolean } {
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
function walkCacheControl(wire: Record<string, unknown>, handler: (current: unknown) => { type: string } | undefined): void {
  for (const key of ["system", "messages", "tools"] as const) {
    if (Array.isArray(wire[key])) {
      walkCacheControlArray(wire[key] as Array<Record<string, unknown>>, handler)
    }
  }
}

function walkCacheControlArray(
  // Runtime data: items may include null / non-objects coming from JSON.parse
  // even though our internal type narrows them, so accept `unknown`-ish entries.
  items: Array<Record<string, unknown> | null | undefined>,
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
