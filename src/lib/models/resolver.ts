/**
 * Unified model name resolution and normalization.
 *
 * Handles short aliases (opus/sonnet/haiku) — resolved ONLY via `model_mappings`,
 * no built-in family fallback — plus catalog-driven spelling canonicalization
 * (claude-opus-4-6 → claude-opus-4.6, data-driven off `/models`) and override
 * chains. Date suffixes are NOT auto-stripped — mapping a dated snapshot name to a
 * canonical id is a config-driven `model_mappings` decision.
 */

import consola from "consola"

import { state } from "~/lib/state"

import { normalizeForMatching } from "./model-name"
import {
  //
  extractModifierSuffix,
  type RouteOverride,
  stripRouteSuffix,
} from "./normalize-id"

// Re-exported so existing importers keep using `~/lib/models/resolver`.
export { normalizeForMatching } from "./model-name"
export { normalizeModelId, type RouteOverride } from "./normalize-id"

// ============================================================================
// Types
// ============================================================================

export type ModelFamily = "opus" | "sonnet" | "haiku"

/**
 * Coarse model class used to pick tool-name sanitization rules. Distinguishes
 * upstreams by their tool-name constraints (dot support, max length) rather
 * than by exact model identity.
 */
export type ModelClass = "gemini" | "gpt" | "claude" | "default"

/** Per-class tool-name constraints for the sanitize-tool-names feature. */
export interface ToolNameRules {
  /** Whether the upstream accepts dots (`.`) in tool names. */
  allowDots: boolean
  /** Maximum permitted tool-name length. */
  maxNameLength: number
}

// ============================================================================
// Normalization and Detection
// ============================================================================

/**
 * True when two model names refer to the SAME model written differently —
 * i.e. they differ only by hyphen/dot/case normalization (e.g.
 * "claude-opus-4-8" vs "claude-opus-4.8"), not a genuine alias→canonical remap
 * (e.g. "haiku" → "claude-sonnet-4.6"). Used to suppress the noisy
 * "client → resolved" arrow in logs when nothing actually changed.
 */
export function isSameModelName(clientModel: string, model: string): boolean {
  return normalizeForMatching(clientModel) === normalizeForMatching(model)
}

/**
 * Normalize the KEYS of a model-keyed config record via `normalizeForMatching`
 * so that spelling variants (dot/hyphen/case) all match the same way. The
 * wildcard key `"*"` is preserved verbatim. When two keys collapse to the same
 * normalized model, the LATER one wins (Object insertion order) and a warning
 * names both keys — so an operator who writes `claude-opus-4.8` and
 * `claude-opus-4-8` doesn't silently get one of them ignored.
 */
export function normalizeModelKeyedRecord<T>(record: Record<string, T>, configLabel: string): Record<string, T> {
  const out: Record<string, T> = {}
  const sourceKey = new Map<string, string>()
  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = key === "*" ? "*" : normalizeForMatching(key)
    const prev = sourceKey.get(normalizedKey)
    if (prev !== undefined) {
      consola.warn(`[config] ${configLabel}: "${prev}" and "${key}" refer to the same model after normalization; "${key}" overrides "${prev}"`)
    }
    out[normalizedKey] = value
    sourceKey.set(normalizedKey, key)
  }
  return out
}

/**
 * Normalize the entries of a model-name list via `normalizeForMatching` and drop
 * entries that collapse to an already-seen model (first occurrence wins for
 * ordering; a duplicate triggers a warning naming both spellings).
 */
export function normalizeModelNameList(list: ReadonlyArray<string>, configLabel: string): Array<string> {
  const out: Array<string> = []
  const seen = new Map<string, string>()
  for (const item of list) {
    const normalized = normalizeForMatching(item)
    const prev = seen.get(normalized)
    if (prev !== undefined) {
      consola.warn(`[config] ${configLabel}: "${prev}" and "${item}" refer to the same model after normalization; ignoring duplicate "${item}"`)
      continue
    }
    seen.set(normalized, item)
    out.push(normalized)
  }
  return out
}

/**
 * Look up a model override by normalized model-name comparison, so spelling
 * variants (dot/hyphen/case) of the same model all resolve to the same entry.
 * Returns the first entry whose key normalizes equal to `name`.
 */
function lookupModelOverride(name: string): string | undefined {
  const target = normalizeForMatching(name)
  for (const [key, value] of Object.entries(state.modelMappings)) {
    if (normalizeForMatching(key) === target) return value
  }
  return undefined
}

/** Extract the model family from a model ID. */
export function getModelFamily(modelId: string): ModelFamily | undefined {
  const normalized = normalizeForMatching(modelId)
  if (normalized.includes("opus")) return "opus"
  if (normalized.includes("sonnet")) return "sonnet"
  if (normalized.includes("haiku")) return "haiku"
  return undefined
}

/** Check if a model ID belongs to the Sonnet family. */
export function isSonnetModel(modelId: string): boolean {
  return getModelFamily(modelId) === "sonnet"
}

/** Check if a model ID belongs to the Opus family. */
export function isOpusModel(modelId: string): boolean {
  return getModelFamily(modelId) === "opus"
}

// ============================================================================
// Model Resolution
// ============================================================================

/**
 * Normalize bracket notation to hyphen suffix.
 * Claude Code CLI sends model keys like "opus[1m]" or "claude-opus-4.6[1m]".
 * This converts them to the standard hyphen form: "opus-1m", "claude-opus-4.6-1m".
 */
function normalizeBracketNotation(model: string): string {
  const match = model.match(/^([^[]+)\[([^\]]+)\]$/)
  if (!match) return model
  return `${match[1]}-${match[2].toLowerCase()}`
}

/**
 * Resolve a model name to its canonical form, applying model_mappings.
 *
 * Thin wrapper over {@link resolveModelTarget} that discards the route-override
 * suffix — the 13 legacy callers that only need the canonical NAME keep calling
 * this unchanged (byte-identical: a name with no `@<route>` suffix strips to itself
 * with no override, so the whole override / modifier / normalization pipeline below
 * runs exactly as before).
 */
export function resolveModelName(model: string): string {
  return resolveModelTarget(model).name
}

/**
 * Resolve a model name to its canonical form PLUS any route-override suffix
 * (`@cc` / `@responses` / `@messages`) the client (or an override target) pinned —
 * the config-parse entry point for the translation matrix (RFC §5).
 *
 * Double-layer strip:
 *   1. Peel the top-level client suffix ONCE at the entry (covers the direct-send path
 *      `resolveModelNameCore`, where there is no override to strip through) — e.g. a
 *      client sending `claude-opus-4.8@cc` with no override configured.
 *   2. Each override-chain ring ({@link resolveOverrideTarget}) strips again BEFORE its
 *      `state.modelIds` membership check, so an override TARGET carrying `@<route>`
 *      (`"opus": "claude-opus-4.6@messages"`) does not punch the suffix through into the
 *      resolved id (FAIL-1) — the discovered override rides back up with the value.
 *
 * Precedence: the client-typed top-level suffix is the primary intent and wins; an
 * override-target suffix is the fallback when the client typed none. (Within the
 * override chain, a deeper ring's suffix — closer to the final model — wins over a
 * shallower one.)
 */
export function resolveModelTarget(model: string): { name: string; routeOverride?: RouteOverride } {
  const { base: stripped, routeOverride: topOverride } = stripRouteSuffix(model)
  const { name, routeOverride: chainOverride } = resolveNameWithOverride(stripped)
  const routeOverride = topOverride ?? chainOverride
  return routeOverride ? { name, routeOverride } : { name }
}

/**
 * Resolve an already-suffix-stripped name to `{ name, routeOverride? }`, propagating
 * any route-override discovered in the override chain. Mirrors the legacy
 * `resolveModelName` body exactly (bracket → whole-name override → modifier-suffix
 * redirect → core normalization + final override check); the only addition is
 * threading the chain's `routeOverride` back out.
 *
 * Order:
 * 1. Whole-name override (normalized): "opus", "opus-1m", "claude-opus-4.6" …
 * 2. Modifier suffix ("-1m" / "-fast"): if the BASE has an override but the whole
 *    name doesn't, redirect the base and re-attach the suffix. The redirected base is
 *    already suffix-stripped (so `@cc` cannot get buried mid-name).
 * 3. Alias / hyphen-dot / date normalization (resolveModelNameCore), then a final
 *    override check on the normalized name.
 *
 * No family-level propagation and no built-in defaults: short aliases resolve only if
 * model_mappings defines them, otherwise the name is returned as-is and the upstream
 * rejects it.
 */
function resolveNameWithOverride(model: string): { name: string; routeOverride?: RouteOverride } {
  // 0. Normalize bracket notation: "opus[1m]" → "opus-1m"
  const normalized = normalizeBracketNotation(model)

  // 1. Whole-name override first (exact "opus-1m" wins over the "opus" base).
  const rawOverride = lookupModelOverride(normalized)
  if (rawOverride) {
    return resolveOverrideTarget(normalized, rawOverride)
  }

  // 2. Modifier suffix: redirect via the base override, then re-attach suffix.
  //    e.g. "opus-1m" with no own override but "opus" → "<opus-target>-1m".
  const { base, suffix } = extractModifierSuffix(normalized)
  if (suffix) {
    const baseOverride = lookupModelOverride(base)
    if (baseOverride) {
      const { name: resolvedBase, routeOverride } = resolveOverrideTarget(base, baseOverride)
      const withSuffix = resolvedBase + suffix
      if (state.modelIds.size === 0 || state.modelIds.has(withSuffix)) {
        return routeOverride ? { name: withSuffix, routeOverride } : { name: withSuffix }
      }
      return routeOverride ? { name: resolvedBase, routeOverride } : { name: resolvedBase }
    }
  }

  // 3. Alias / normalization, then a final override check on the resolved name.
  const resolved = resolveModelNameCore(normalized)
  if (resolved !== normalized) {
    const resolvedOverride = lookupModelOverride(resolved)
    if (resolvedOverride) {
      return resolveOverrideTarget(resolved, resolvedOverride)
    }
  }

  // No family-level propagation: a short alias / family override only affects the
  // exact keys defined in model_mappings (spelling variants are unified by
  // normalization). To redirect a whole family, list each canonical name.
  return { name: resolved }
}

/**
 * Resolve override target: if target is directly available, use it; otherwise check
 * for chained overrides, then treat as alias. If still unavailable, use the target
 * as-is (the upstream rejects it — there is no family preference fallback).
 *
 * Each ring strips a trailing `@<route>` off the (config-supplied) target BEFORE the
 * `state.modelIds` membership check, so `"opus": "claude-opus-4.6@cc"` matches the
 * available id `claude-opus-4.6` and returns `routeOverride: "cc"` alongside it,
 * instead of leaking `@cc` into the resolved name (FAIL-1).
 *
 * Uses `seen` set to prevent circular override chains.
 */
function resolveOverrideTarget(source: string, target: string, seen?: Set<string>): { name: string; routeOverride?: RouteOverride } {
  const { base: strippedTarget, routeOverride } = stripRouteSuffix(target)
  const withOv = (name: string): { name: string; routeOverride?: RouteOverride } => (routeOverride ? { name, routeOverride } : { name })

  if (state.modelIds.size === 0 || state.modelIds.has(strippedTarget)) {
    return withOv(strippedTarget)
  }

  // Check if the target itself has an override (chained: sonnet → opus → claude-opus-4.6-1m)
  const visited = seen ?? new Set([source])
  const targetOverride = lookupModelOverride(strippedTarget)
  if (targetOverride && !visited.has(strippedTarget)) {
    visited.add(strippedTarget)
    const deeper = resolveOverrideTarget(strippedTarget, targetOverride, visited)
    // A deeper ring's suffix wins (closer to the final model); fall back to this ring's.
    if (deeper.routeOverride) return deeper
    return routeOverride ? { name: deeper.name, routeOverride } : deeper
  }

  // Target not directly available — might be an alias, resolve it.
  const resolved = resolveModelNameCore(strippedTarget)
  if (resolved !== strippedTarget) {
    return withOv(resolved)
  }

  // Can't resolve further — use the (stripped) target as-is.
  return withOv(strippedTarget)
}

/**
 * Core model name resolution (without overrides).
 *
 * Handles:
 * 1. Modifier suffixes: "claude-opus-4-6-fast" → "claude-opus-4.6-fast"
 * 2. Short aliases ("opus"): resolved ONLY via model_mappings (this function has
 *    no built-in family fallback — a bare alias with no override is returned as-is).
 * 3. Spelling canonicalization via the live catalog: "claude-opus-4-6" →
 *    "claude-opus-4.6" (data-driven off `/models`, not a hard-coded regex).
 *
 * Date suffixes are NOT stripped: "claude-opus-4-6-20250514" has no catalog twin
 * and is returned as-is (only a matching `model_mappings` entry can remap it).
 */
function resolveModelNameCore(model: string): string {
  // Extract modifier suffix (e.g., "-fast") before resolution
  const { base, suffix } = extractModifierSuffix(model)

  // Resolve the base model name
  const resolvedBase = resolveBase(base)

  // Re-attach suffix and validate availability
  if (suffix) {
    const withSuffix = resolvedBase + suffix
    if (state.modelIds.size === 0 || state.modelIds.has(withSuffix)) {
      return withSuffix
    }
    // Suffixed variant not available, fall back to base
    return resolvedBase
  }

  return resolvedBase
}

/**
 * Canonicalize a model name by spelling-insensitive lookup against the live
 * `/models` catalog: if some available model's id matches `model` up to
 * dot/hyphen/case normalization (`normalizeForMatching`), return that model's
 * REAL id (the upstream's canonical spelling). Otherwise `undefined`.
 *
 * This replaces the old hard-coded `claude-{family}-{major}-{minor}` regex: the
 * canonical form is now DATA-DRIVEN off `/models`, so it works for any model
 * whose id contains dots (e.g. `gemini-3.1-pro-preview`), never invents a name
 * absent from the catalog, and needs no per-model config. Spelling equivalence
 * (hyphen↔dot) is a property of the same model, like case-insensitivity — not a
 * policy decision, so it stays here rather than in `model_mappings`.
 */
function canonicalizeFromCatalog(model: string): string | undefined {
  const target = normalizeForMatching(model)
  for (const available of state.modelIndex.values()) {
    if (normalizeForMatching(available.id) === target) return available.id
  }
  return undefined
}

/** Resolve a base model name (without modifier suffix) to its canonical form. */
function resolveBase(model: string): string {
  // Spelling normalization (hyphen→dot etc.) is data-driven off the live catalog:
  // a client spelling like claude-opus-4-6 resolves to the upstream's real id
  // claude-opus-4.6. Date suffixes are NOT stripped — a dated snapshot name has no
  // catalog twin, so it falls through unchanged and only an explicit model_mappings
  // entry can remap it (otherwise the upstream rejects it — failure stays visible).
  //
  // Unlike the modifier/override paths' `modelIds.size === 0` optimistic accept, base
  // canonicalization is purely data-driven: an empty catalog means NO canonicalization
  // (returns verbatim). This is production-unreachable — cacheModels() runs before the
  // server serves — and the two paths never disagree because an empty catalog also
  // leaves the base untransformed, so there is no "base dotted but suffix rejected" case.
  const canonical = canonicalizeFromCatalog(model)
  if (canonical !== undefined) {
    return canonical
  }

  // Short aliases (opus/sonnet/haiku), dated snapshot names, and anything else are
  // returned verbatim; they only resolve if model_mappings defines them, otherwise
  // the upstream rejects the unknown model (resolution intentionally fails — no
  // built-in family preference fallback and no date-suffix stripping).
  return model
}

// ============================================================================
// Tool-name sanitization classification
// ============================================================================

/** Per-class tool-name rules. claude/default share the strict (no-dots, 64) rule. */
const TOOL_NAME_RULES_BY_CLASS: Record<ModelClass, ToolNameRules> = {
  gemini: { allowDots: true, maxNameLength: 128 },
  gpt: { allowDots: true, maxNameLength: 128 },
  claude: { allowDots: false, maxNameLength: 64 },
  default: { allowDots: false, maxNameLength: 64 },
}

/**
 * Classify a model into a coarse class for tool-name sanitization rules.
 *
 * Resolution order:
 * 1. Runtime `vendor` (from `Model.vendor`, e.g. "OpenAI"/"Google"/"Anthropic")
 *    when supplied — the authoritative signal.
 * 2. Name heuristics on the model id (`gpt-*`, `gemini`, `claude`) as a fallback
 *    when the model isn't in the index / vendor is unknown.
 * 3. `"default"` when nothing matches.
 */
export function getModelClass(modelId: string, vendor?: string): ModelClass {
  const v = vendor?.trim().toLowerCase()
  if (v) {
    if (v.includes("google")) return "gemini"
    if (v.includes("openai")) return "gpt"
    if (v.includes("anthropic")) return "claude"
  }

  const id = modelId.trim().toLowerCase()
  if (id.includes("gemini")) return "gemini"
  if (id.startsWith("gpt-")) return "gpt"
  if (id.includes("claude")) return "claude"
  return "default"
}

/**
 * Resolve the tool-name sanitization rules (dot support + length cap) for a
 * model, classifying via `getModelClass`.
 */
export function getToolNameRulesForModel(modelId: string, vendor?: string): ToolNameRules {
  return TOOL_NAME_RULES_BY_CLASS[getModelClass(modelId, vendor)]
}
