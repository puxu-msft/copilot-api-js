/**
 * Unified model name resolution and normalization.
 *
 * Consolidates model name handling from:
 * - non-stream-translation.ts: MODEL_PREFERENCE, findPreferredModel, resolveModelName
 * - anthropic/features.ts: normalizeModelId (renamed to normalizeForMatching)
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

/**
 * Normalize model ID for matching: lowercase and replace dots with dashes.
 * e.g. "claude-sonnet-4.5" → "claude-sonnet-4-5"
 *
 * Used for feature detection (startsWith matching), NOT for API calls.
 */
export function normalizeForMatching(modelId: string): string {
  return modelId.toLowerCase().replaceAll(".", "-")
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

  const availableIds = state.models?.data.map((m) => m.id)
  if (!availableIds || availableIds.length === 0) {
    return preference[0]
  }

  for (const candidate of preference) {
    if (availableIds.includes(candidate)) {
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
  const match = model.match(/^(.+)\[([^\]]+)\]$/)
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
  model = normalizeBracketNotation(model)

  // 1. Check raw model name against overrides first
  const rawOverride = state.modelOverrides[model]
  if (rawOverride) {
    return resolveOverrideTarget(model, rawOverride)
  }

  // 2. Normal alias/normalization resolution
  const resolved = resolveModelNameCore(model)

  // 3. If resolved name is different, check it against overrides too
  if (resolved !== model) {
    const resolvedOverride = state.modelOverrides[resolved]
    if (resolvedOverride) {
      return resolveOverrideTarget(resolved, resolvedOverride)
    }
  }

  // 4. Check if the model's family has a user-customized override
  //    Only applies when the family override differs from the built-in default
  //    (default overrides are just alias mappings, not redirections)
  //    e.g., user sets opus → claude-opus-4.6-1m, then claude-opus-4-6 should also redirect
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
  const availableIds = state.models?.data.map((m) => m.id)
  if (!availableIds || availableIds.length === 0 || availableIds.includes(target)) {
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
    const availableIds = state.models?.data.map((m) => m.id)
    if (!availableIds || availableIds.length === 0 || availableIds.includes(withSuffix)) {
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
  const versionedMatch = model.match(/^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d{1,2})(?:-\d{8,})?$/)
  if (versionedMatch) {
    const dotModel = `${versionedMatch[1]}-${versionedMatch[2]}.${versionedMatch[3]}`
    const availableIds = state.models?.data.map((m) => m.id)
    if (!availableIds || availableIds.length === 0 || availableIds.includes(dotModel)) {
      return dotModel
    }
  }

  // 3. Date-only suffix: claude-{family}-{major}-YYYYMMDD → base model or best family
  const dateOnlyMatch = model.match(/^(claude-(opus|sonnet|haiku)-\d+)-\d{8,}$/)
  if (dateOnlyMatch) {
    const baseModel = dateOnlyMatch[1]
    const family = dateOnlyMatch[2]
    const availableIds = state.models?.data.map((m) => m.id)
    if (availableIds?.includes(baseModel)) {
      return baseModel
    }
    return findPreferredModel(family)
  }

  return model
}
