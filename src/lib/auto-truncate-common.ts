/**
 * Common types and configuration for auto-truncate modules.
 * Shared between OpenAI and Anthropic format handlers.
 */

import consola from "consola"

// ============================================================================
// Configuration
// ============================================================================

/** Configuration for auto-truncate behavior */
export interface AutoTruncateConfig {
  /** Safety margin percentage to account for token counting differences (default: 2) */
  safetyMarginPercent: number
  /** Maximum request body size in bytes (default: 510KB) */
  maxRequestBodyBytes: number
}

export const DEFAULT_AUTO_TRUNCATE_CONFIG: AutoTruncateConfig = {
  safetyMarginPercent: 2,
  maxRequestBodyBytes: 510 * 1024, // 510KB (585KB known to fail)
}

// ============================================================================
// Dynamic Byte Limit
// ============================================================================

/** Dynamic byte limit that adjusts based on 413 errors */
let dynamicByteLimit: number | null = null

/**
 * Called when a 413 error occurs. Adjusts the byte limit to 90% of the failing size.
 */
export function onRequestTooLarge(failingBytes: number): void {
  const newLimit = Math.max(Math.floor(failingBytes * 0.9), 100 * 1024)
  dynamicByteLimit = newLimit
  consola.info(
    `[AutoTruncate] Adjusted byte limit: ${Math.round(failingBytes / 1024)}KB failed → ${Math.round(newLimit / 1024)}KB`,
  )
}

/** Get the current effective byte limit */
export function getEffectiveByteLimitBytes(): number {
  return dynamicByteLimit ?? DEFAULT_AUTO_TRUNCATE_CONFIG.maxRequestBodyBytes
}

/** Reset the dynamic byte limit (for testing) */
export function resetByteLimitForTesting(): void {
  dynamicByteLimit = null
}

// ============================================================================
// Dynamic Token Limit (per model)
// ============================================================================

/** Dynamic token limits per model, adjusted based on token limit errors */
const dynamicTokenLimits: Map<string, number> = new Map()

/**
 * Called when a token limit error (400) occurs.
 * Adjusts the token limit for the specific model to 95% of the reported limit.
 */
export function onTokenLimitExceeded(
  modelId: string,
  reportedLimit: number,
): void {
  // Use 95% of the reported limit to add safety margin
  const newLimit = Math.floor(reportedLimit * 0.95)
  const previous = dynamicTokenLimits.get(modelId)

  // Only update if the new limit is lower (more restrictive)
  if (!previous || newLimit < previous) {
    dynamicTokenLimits.set(modelId, newLimit)
    consola.info(
      `[AutoTruncate] Adjusted token limit for ${modelId}: ${reportedLimit} reported → ${newLimit} effective`,
    )
  }
}

/**
 * Get the effective token limit for a model.
 * Returns the dynamic limit if set, otherwise null to use model capabilities.
 */
export function getEffectiveTokenLimit(modelId: string): number | null {
  return dynamicTokenLimits.get(modelId) ?? null
}

/** Reset all dynamic limits (for testing) */
export function resetAllLimitsForTesting(): void {
  dynamicByteLimit = null
  dynamicTokenLimits.clear()
}
