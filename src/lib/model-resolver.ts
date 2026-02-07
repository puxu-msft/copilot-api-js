/**
 * Unified model name resolution and normalization.
 *
 * Consolidates model name handling from:
 * - non-stream-translation.ts: MODEL_PREFERENCE, findPreferredModel, translateModelName
 * - anthropic/features.ts: normalizeModelId (renamed to normalizeForMatching)
 */

import consola from "consola"

import { state } from "~/lib/state"

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

export interface ResolveModelOptions {
  redirectSonnetToOpus?: boolean
}

/**
 * Resolve a model name to its canonical form.
 *
 * Handles:
 * 1. Short aliases: "opus" → best available opus
 * 2. Hyphenated versions: "claude-opus-4-6" → "claude-opus-4.6"
 * 3. Date suffixes: "claude-opus-4-20250514" → best opus
 * 4. Sonnet → Opus redirect (when enabled)
 */
export function resolveModelName(model: string, options?: ResolveModelOptions): string {
  const resolved = model

  // 1. Short alias: "opus" → best opus
  if (resolved in MODEL_PREFERENCE) {
    return applyRedirect(findPreferredModel(resolved), options)
  }

  // 2. Hyphenated: claude-opus-4-6 or claude-opus-4-6-20250514 → claude-opus-4.6
  // Pattern: claude-{family}-{major}-{minor}[-YYYYMMDD]
  // Minor version is 1-2 digits; date suffix is 8+ digits
  const versionedMatch = resolved.match(/^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d{1,2})(?:-\d{8,})?$/)
  if (versionedMatch) {
    const dotModel = `${versionedMatch[1]}-${versionedMatch[2]}.${versionedMatch[3]}`
    const availableIds = state.models?.data.map((m) => m.id)
    if (!availableIds || availableIds.length === 0 || availableIds.includes(dotModel)) {
      return applyRedirect(dotModel, options)
    }
  }

  // 3. Date-only suffix: claude-{family}-{major}-YYYYMMDD → base model or best family
  const dateOnlyMatch = resolved.match(/^(claude-(opus|sonnet|haiku)-\d+)-\d{8,}$/)
  if (dateOnlyMatch) {
    const baseModel = dateOnlyMatch[1]
    const family = dateOnlyMatch[2]
    const availableIds = state.models?.data.map((m) => m.id)
    if (availableIds?.includes(baseModel)) {
      return applyRedirect(baseModel, options)
    }
    return applyRedirect(findPreferredModel(family), options)
  }

  return applyRedirect(resolved, options)
}

/** Apply sonnet → opus redirect if enabled. */
function applyRedirect(model: string, options?: ResolveModelOptions): string {
  if (options?.redirectSonnetToOpus && isSonnetModel(model)) {
    const opus = findPreferredModel("opus")
    consola.info(`[Model] Redirecting ${model} → ${opus} (redirect-sonnet-to-opus)`)
    return opus
  }
  return model
}

/**
 * Convenience wrapper that reads redirect flags from global state.
 * This is the main entry point for route handlers.
 */
export function translateModelName(model: string): string {
  return resolveModelName(model, {
    redirectSonnetToOpus: state.redirectSonnetToOpus,
  })
}
