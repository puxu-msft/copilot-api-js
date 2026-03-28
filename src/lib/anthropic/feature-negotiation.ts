import { copilotBaseUrl } from "~/lib/copilot-api"
import { normalizeForMatching } from "~/lib/models/resolver"
import { state } from "~/lib/state"

export type AnthropicNegotiatedFeature = "context_management"

const NEGOTIATION_TTL_MS = 10 * 60 * 1000
const unsupportedFeatures = new Map<string, number>()

function makeKey(modelId: string, feature: AnthropicNegotiatedFeature): string {
  return `${copilotBaseUrl(state)}|anthropic-messages|${normalizeForMatching(modelId)}|${feature}`
}

function isFresh(expiresAt: number): boolean {
  return expiresAt > Date.now()
}

export function markAnthropicFeatureUnsupported(modelId: string, feature: AnthropicNegotiatedFeature): void {
  unsupportedFeatures.set(makeKey(modelId, feature), Date.now() + NEGOTIATION_TTL_MS)
}

export function isAnthropicFeatureUnsupported(modelId: string, feature: AnthropicNegotiatedFeature): boolean {
  const key = makeKey(modelId, feature)
  const expiresAt = unsupportedFeatures.get(key)
  if (!expiresAt) return false
  if (isFresh(expiresAt)) return true
  unsupportedFeatures.delete(key)
  return false
}

export function resetAnthropicFeatureNegotiationForTesting(): void {
  unsupportedFeatures.clear()
}
