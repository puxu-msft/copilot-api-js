/**
 * `model_translation` per-pair feature query (RFC 2026-07-14-anthropic-responses-direct-bridge
 * §6.1, Phase 7 of that RFC's plan).
 *
 * Phase 7 scope: read the parsed config out of `state.modelTranslation` and expose a single query
 * primitive. Phase 5 wires it in: {@link resolveTranslationFeatures} is called from INSIDE the hub's
 * bridge-selection functions (`hub-translate.ts`), never per-cell `translateOut` (RFC §6.1's explicit
 * warning against two call sites drifting out of sync) — see {@link ingressForClientFormat} /
 * {@link stripThinkingSignatureFor}, the two small adapters `hub-translate.ts` uses to bridge the
 * pipeline's `ClientFormat`/`UpstreamEndpoint` vocabulary to this module's `ModelTranslationIngress`
 * one (RFC §6.1: intentionally a SEPARATE enum, not a reuse of `ClientFormat`).
 */

import type {
  //
  ModelTranslationFeature,
  ModelTranslationIngress,
} from "~/lib/config/schema"
import type { Model } from "~/lib/models/client"

import { state } from "~/lib/state"

/**
 * Resolve the declared translation features for a `(ingress, model@format)` pair.
 *
 * `match` is evaluated against the FINAL routed target — `model` and `format` here are the
 * post-`model_mappings`, post-router-decision values (RFC §6.1: "对最终路由结果...匹配，非对客户
 * 端原始 model 名匹配"), never the client's raw requested model name. `format` uses the same
 * four-value vocabulary as the ingress enum (`anthropic-messages` / `openai-cc` /
 * `openai-responses` / `gemini`) since it names the SAME concept (a format) on the other end of
 * the pair.
 *
 * v1 matching is EXACT-STRING ONLY (no wildcard/glob — RFC §6.1 OQ2 defers that). First matching
 * rule in the ingress's rule list wins (array order); if no rule's `match` equals
 * `${model}@${format}`, or the ingress has no rules declared at all, returns an empty array —
 * scenario A (full round-trip, no stripped features) is the default for every undeclared pair.
 */
export function resolveTranslationFeatures(
  ingress: ModelTranslationIngress,
  model: string,
  format: ModelTranslationIngress,
): ReadonlyArray<ModelTranslationFeature> {
  const rules = state.modelTranslation[ingress]
  if (!rules || rules.length === 0) return []

  const target = `${model}@${format}`
  const matched = rules.find((rule) => rule.match === target)
  return matched?.features ?? []
}

/**
 * Map the pipeline's terser `ClientFormat` (`anthropic`/`openai-cc`/`openai-responses`/`gemini`) to
 * this module's `-messages`/`-cc`/`-responses`-suffixed `ModelTranslationIngress` vocabulary (RFC
 * §6.1: the two enums are intentionally SEPARATE, not one reused — see schema.ts's
 * `MODEL_TRANSLATION_INGRESS_VALUES` docstring).
 */
export function ingressForClientFormat(clientFormat: "anthropic" | "openai-cc" | "openai-responses" | "gemini"): ModelTranslationIngress {
  return clientFormat === "anthropic" ? "anthropic-messages" : clientFormat
}

/**
 * Phase 5 scenario A/B decision, RFC §4.3: is `strip-thinking-signature` declared for THIS
 * `(ingress, model@format)` pair? `ingress` is the CLIENT's inbound format; `format` is the OTHER
 * end of the reasoning round-trip (the format whose reasoning/thinking carrier is being rendered).
 * `model` is the FINAL routed model id (never the client's raw requested name); absent model → false
 * (no pair to match, scenario A default).
 */
export function stripThinkingSignatureFor(ingress: ModelTranslationIngress, model: string | undefined, format: ModelTranslationIngress): boolean {
  if (!model) return false
  return resolveTranslationFeatures(ingress, model, format).includes("strip-thinking-signature")
}

/** Resolve a `Model`/body-fallback into the bare model id string `resolveTranslationFeatures` matches on. */
export function modelIdFor(model: Model | undefined, bodyModel: string | undefined): string | undefined {
  return model?.id ?? bodyModel
}
