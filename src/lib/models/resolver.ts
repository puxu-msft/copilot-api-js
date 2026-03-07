/**
 * Unified model name resolution and normalization.
 *
 * Handles short aliases (opus/sonnet/haiku), versioned names with date suffixes,
 * hyphenated versions (claude-opus-4-6 → claude-opus-4.6), model overrides,
 * and family-level fallbacks.
 */

import { DEFAULT_MODEL_OVERRIDES, state } from "~/lib/state"

// ============================================================================
// Types
// ============================================================================

export type ModelFamily = "opus" | "sonnet" | "haiku"

// ============================================================================
// Model Preference Lists
// ============================================================================

/** Preferred model order per family, highest priority first. */
export const MODEL_PREFERENCE: Record<ModelFamily, Array<string>> = {
  opus: [
    "claude-opus-4.6",
    "claude-opus-4.5",
    "claude-opus-41", // 4.1
    // "claude-opus-4",
  ],
  sonnet: [
    "claude-sonnet-4.6",
    "claude-sonnet-4.5",
    "claude-sonnet-4",
    // "claude-sonnet-3.5",
  ],
  haiku: [
    "claude-haiku-4.5",
    // "claude-haiku-3.5",
  ],
}

// ============================================================================
// Normalization and Detection
// ============================================================================

/** Pre-compiled regex: claude-{family}-{major}-{minor}[-YYYYMMDD] */
const VERSIONED_RE = /^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d{1,2})(?:-\d{8,})?$/

/** Pre-compiled regex: claude-{family}-{major}-YYYYMMDD (date-only suffix) */
const DATE_ONLY_RE = /^(claude-(opus|sonnet|haiku)-\d+)-\d{8,}$/

/**
 * Normalize model ID for matching: lowercase and replace dots with dashes.
 * e.g. "claude-sonnet-4.5" → "claude-sonnet-4-5"
 *
 * Used for feature detection (startsWith matching), NOT for API calls.
 */
export function normalizeForMatching(modelId: string): string {
  return modelId.toLowerCase().replaceAll(".", "-")
}

/**
 * Normalize a model ID to canonical dot-version form.
 * e.g. "claude-opus-4-6" → "claude-opus-4.6", "claude-opus-4-6-1m" → "claude-opus-4.6-1m"
 *
 * Handles modifier suffixes (-fast, -1m) and strips date suffixes (-YYYYMMDD).
 * Non-Claude models or unrecognized patterns are returned as-is.
 *
 * Used for normalizing API response model names to match `/models` endpoint IDs.
 */
export function normalizeModelId(modelId: string): string {
  const { base, suffix } = extractModifierSuffix(modelId)
  const versionedMatch = base.match(VERSIONED_RE)
  if (versionedMatch) {
    return `${versionedMatch[1]}-${versionedMatch[2]}.${versionedMatch[3]}${suffix}`
  }
  return modelId
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
 * Find the best available model for a family by checking the preference list
 * against actually available models. Returns the first match, or the top
 * preference as fallback when state.models is unavailable.
 */
export function findPreferredModel(family: string): string {
  const preference = MODEL_PREFERENCE[family as ModelFamily]
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive for arbitrary family strings
  if (!preference) return family

  if (state.modelIds.size === 0) {
    return preference[0]
  }

  for (const candidate of preference) {
    if (state.modelIds.has(candidate)) {
      return candidate
    }
  }

  return preference[0]
}

/** Known model modifier suffixes (e.g., "-fast" for fast output mode, "-1m" for 1M context). */
const KNOWN_MODIFIERS = ["-fast", "-1m"]

/**
 * Extract known modifier suffix from a model name.
 * e.g. "claude-opus-4-6-fast" → { base: "claude-opus-4-6", suffix: "-fast" }
 */
function extractModifierSuffix(model: string): { base: string; suffix: string } {
  const lower = model.toLowerCase()
  for (const modifier of KNOWN_MODIFIERS) {
    if (lower.endsWith(modifier)) {
      return { base: model.slice(0, -modifier.length), suffix: modifier }
    }
  }
  return { base: model, suffix: "" }
}

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
 * Resolve a model name to its canonical form, then apply overrides.
 *
 * Override matching order:
 * 1. Check the raw (original) model name against state.modelOverrides
 * 2. Resolve via alias/normalization (resolveModelNameCore)
 * 3. If resolved name differs from raw, check resolved name against overrides
 * 4. Check if the model's family (opus/sonnet/haiku) has an override
 *
 * This is the main entry point for route handlers.
 */
export function resolveModelName(model: string): string {
  // 0. Normalize bracket notation: "opus[1m]" → "opus-1m"
  const normalized = normalizeBracketNotation(model)

  // 1. Check raw model name against overrides first
  const rawOverride = state.modelOverrides[normalized]
  if (rawOverride) {
    return resolveOverrideTarget(normalized, rawOverride)
  }

  // 2. Normal alias/normalization resolution
  const resolved = resolveModelNameCore(normalized)

  // 3. If resolved name is different, check it against overrides too
  if (resolved !== normalized) {
    const resolvedOverride = state.modelOverrides[resolved]
    if (resolvedOverride) {
      return resolveOverrideTarget(resolved, resolvedOverride)
    }
  }

  // 4. Check if the model's family has a user-customized override
  //    Last-resort fallback: only applies when steps 1-3 didn't match.
  //    Propagates to ALL family members regardless of target family.
  //    e.g., opus → claude-opus-4.6-1m: claude-opus-4-6 also redirects
  //    e.g., sonnet → opus: claude-sonnet-4 also redirects (cross-family)
  //    Only skipped when override equals the built-in default (pure alias, not redirection).
  const family = getModelFamily(resolved)
  if (family) {
    const familyOverride = state.modelOverrides[family]
    if (familyOverride && familyOverride !== DEFAULT_MODEL_OVERRIDES[family]) {
      const familyResolved = resolveOverrideTarget(family, familyOverride)
      if (familyResolved !== resolved) {
        return familyResolved
      }
    }
  }

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
  const targetOverride = state.modelOverrides[target]
  if (targetOverride && !visited.has(target)) {
    visited.add(target)
    return resolveOverrideTarget(target, targetOverride, visited)
  }

  // Target not directly available — might be an alias, resolve it
  const resolved = resolveModelNameCore(target)
  if (resolved !== target) {
    return resolved
  }

  // Still not resolved — check if target belongs to a known family and find best available
  const family = getModelFamily(target)
  if (family) {
    const preferred = findPreferredModel(family)
    if (preferred !== target) {
      return preferred
    }
  }

  // Can't resolve further — use target as-is
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
  // 1. Short alias: "opus" → best opus
  if (model in MODEL_PREFERENCE) {
    return findPreferredModel(model)
  }

  // 2. Hyphenated: claude-opus-4-6 or claude-opus-4-6-20250514 → claude-opus-4.6
  // Pattern: claude-{family}-{major}-{minor}[-YYYYMMDD]
  // Minor version is 1-2 digits; date suffix is 8+ digits
  const versionedMatch = model.match(VERSIONED_RE)
  if (versionedMatch) {
    const dotModel = `${versionedMatch[1]}-${versionedMatch[2]}.${versionedMatch[3]}`
    if (state.modelIds.size === 0 || state.modelIds.has(dotModel)) {
      return dotModel
    }
  }

  // 3. Date-only suffix: claude-{family}-{major}-YYYYMMDD → base model or best family
  const dateOnlyMatch = model.match(DATE_ONLY_RE)
  if (dateOnlyMatch) {
    const baseModel = dateOnlyMatch[1]
    const family = dateOnlyMatch[2]
    if (state.modelIds.has(baseModel)) {
      return baseModel
    }
    return findPreferredModel(family)
  }

  return model
}
