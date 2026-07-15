/**
 * `model_translation` per-pair feature query (RFC 2026-07-14-anthropic-responses-direct-bridge
 * §6.1, Phase 7 of that RFC's plan).
 *
 * Phase 7 scope ONLY: read the parsed config out of `state.modelTranslation` and expose a single
 * query primitive. This module is NOT wired into the bridge-selection layer yet (that's Phase 5)
 * — `resolveTranslationFeatures()` exists so Phase 5 has a stable, format-agnostic entry point to
 * call from inside the bridge-selection function (not per-cell `translateOut`, per RFC §6.1's
 * explicit warning against two call sites drifting out of sync).
 */

import type {
  //
  ModelTranslationFeature,
  ModelTranslationIngress,
} from "~/lib/config/schema"

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
