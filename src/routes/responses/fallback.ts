/**
 * Force-fallback vendor list for /v1/responses.
 *
 * Some vendors' Copilot /responses upstream is broken or absent; the Responses
 * codec (`lib/codec/openai-responses/codec.ts`) consults
 * `shouldForceChatCompletionsFallback` to route them through the CC fallback even
 * when the model claims /responses support. (The fallback EXECUTION now lives in
 * the v4 driver path — codec `prepareWire` + `conversation-rebuild.ts` — not here.)
 */

import type { Model } from "~/lib/models/client"

/**
 * Vendors whose Copilot /responses upstream is broken or absent; force
 * fallback even when the model claims to support /responses.
 *
 * Rationale: Copilot's /responses upstream returns 5xx for several Gemini
 * SKUs. Until Copilot stabilizes that path, route Google models through
 * /chat/completions. Update this list when upstream is fixed.
 */
const FORCE_CC_VENDORS = new Set<string>(["Google"])

export function shouldForceChatCompletionsFallback(model: Model | undefined): boolean {
  return Boolean(model?.vendor && FORCE_CC_VENDORS.has(model.vendor))
}
