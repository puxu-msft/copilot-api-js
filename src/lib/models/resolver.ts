/**
 * Unified model name resolution and normalization.
 *
 * Handles short aliases (opus/sonnet/haiku), versioned names with date suffixes,
 * hyphenated versions (claude-opus-4-6 → claude-opus-4.6), model overrides,
 * and family-level fallbacks.
 */

import consola from "consola"

import { state } from "~/lib/state"

import { normalizeForMatching } from "./model-name"
import {
  //
  extractModifierSuffix,
  VERSIONED_RE,
} from "./normalize-id"

// Re-exported so existing importers keep using `~/lib/models/resolver`.
export { normalizeForMatching } from "./model-name"
export { normalizeModelId } from "./normalize-id"

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

/** Pre-compiled regex: claude-{family}-{major}-YYYYMMDD (date-only suffix) */
const DATE_ONLY_RE = /^(claude-(?:opus|sonnet|haiku)-\d+)-\d{8,}$/

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
  for (const [key, value] of Object.entries(state.modelOverrides)) {
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
 * Resolve a model name to its canonical form, applying model_overrides.
 *
 * Order:
 * 1. Whole-name override (normalized): "opus", "opus-1m", "claude-opus-4.6" …
 * 2. Modifier suffix ("-1m" / "-fast"): if the BASE has an override but the
 *    whole name doesn't, redirect the base and re-attach the suffix.
 *    e.g. "opus[1m]" → "opus-1m"; with no "opus-1m" override but an "opus"
 *    override → "<opus-target>-1m" (falls back to the bare target if the
 *    suffixed variant isn't available).
 * 3. Alias / hyphen-dot / date normalization (resolveModelNameCore), then a
 *    final override check on the normalized name.
 *
 * No family-level propagation and no built-in defaults: short aliases resolve
 * only if model_overrides defines them, otherwise the name is returned as-is
 * and the upstream rejects it.
 */
export function resolveModelName(model: string): string {
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
      const resolvedBase = resolveOverrideTarget(base, baseOverride)
      const withSuffix = resolvedBase + suffix
      if (state.modelIds.size === 0 || state.modelIds.has(withSuffix)) {
        return withSuffix
      }
      return resolvedBase
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

  // No family-level propagation: a short alias / family override only affects
  // the exact keys defined in model_overrides (spelling variants are unified by
  // normalization). To redirect a whole family, list each canonical name.
  return resolved
}

/**
 * Resolve override target: if target is directly available, use it;
 * otherwise check for chained overrides, then treat as alias.
 * If still unavailable, fall back to the best available model in the same family.
 *
 * Uses `seen` set to prevent circular override chains.
 */
function resolveOverrideTarget(source: string, target: string, seen?: Set<string>): string {
  if (state.modelIds.size === 0 || state.modelIds.has(target)) {
    return target
  }

  // Check if target itself has an override (chained overrides: sonnet → opus → claude-opus-4.6-1m)
  const visited = seen ?? new Set([source])
  const targetOverride = lookupModelOverride(target)
  if (targetOverride && !visited.has(target)) {
    visited.add(target)
    return resolveOverrideTarget(target, targetOverride, visited)
  }

  // Target not directly available — might be an alias, resolve it
  const resolved = resolveModelNameCore(target)
  if (resolved !== target) {
    return resolved
  }

  // Can't resolve further — use target as-is. The upstream rejects it if
  // unavailable; there is no built-in family preference fallback.
  return target
}

/**
 * Core model name resolution (without overrides).
 *
 * Handles:
 * 1. Modifier suffixes: "claude-opus-4-6-fast" → "claude-opus-4.6-fast"
 * 2. Short aliases: "opus" → best available opus
 * 3. Hyphenated versions: "claude-opus-4-6" → "claude-opus-4.6"
 * 4. Date suffixes: "claude-opus-4-20250514" → best opus
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

/** Resolve a base model name (without modifier suffix) to its canonical form. */
function resolveBase(model: string): string {
  // 1. Hyphenated: claude-opus-4-6 or claude-opus-4-6-20250514 → claude-opus-4.6
  // Pattern: claude-{family}-{major}-{minor}[-YYYYMMDD]
  // Minor version is 1-2 digits; date suffix is 8+ digits
  const versionedMatch = model.match(VERSIONED_RE)
  if (versionedMatch) {
    const dotModel = `${versionedMatch[1]}-${versionedMatch[2]}.${versionedMatch[3]}`
    if (state.modelIds.size === 0 || state.modelIds.has(dotModel)) {
      return dotModel
    }
  }

  // 2. Date-only suffix: claude-{family}-{major}-YYYYMMDD → base model (drop date).
  // If the base isn't available, return it as-is and let the upstream reject —
  // short aliases / families are resolved exclusively via model_overrides now.
  const dateOnlyMatch = model.match(DATE_ONLY_RE)
  if (dateOnlyMatch) {
    return dateOnlyMatch[1]
  }

  // Short aliases (opus/sonnet/haiku) and anything else are returned verbatim;
  // they only resolve if model_overrides defines them, otherwise the upstream
  // rejects the unknown model (resolution intentionally fails — no built-in
  // family preference fallback).
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
