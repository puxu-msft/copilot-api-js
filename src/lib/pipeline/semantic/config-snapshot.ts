/**
 * The immutable `model_translation` view a single request is decided against.
 *
 * RFC §6 requires ingress to capture this **once, before any route or candidate fork**, and every
 * descendant candidate to resolve its policy from that one snapshot: a hot reload may only affect
 * later requests. Without it, a config edit landing mid-request could give the retry leg a different
 * policy from the first attempt — the same conversation translated two ways, with nothing in the
 * record saying why.
 *
 * Capture happens in the ingress middleware (`src/server.ts`), immediately after
 * `applyConfigToState()` has settled this request's config and before the token refresh that may
 * spend real seconds. That is the same reasoning that already pins `ingressAtMs` a few lines above
 * it. The inbound codecs only ever *read* the captured snapshot and pin it onto the envelope.
 */

import type { Context } from "hono"

import { createHash } from "node:crypto"

import type {
  //
  ModelTranslation,
  ModelTranslationIngress,
  ModelTranslationRule,
} from "~/lib/state-vocabulary"

import { state } from "~/lib/state"

/**
 * The read-only view of `model_translation` a snapshot exposes.
 *
 * `Readonly<>` does not reach inside each rule's `features` array, but {@link freezeModelTranslation}
 * freezes those too — the runtime is stricter than the type here, deliberately, so a consumer that
 * finds a way past the type still cannot move a captured snapshot.
 */
export type FrozenModelTranslation = Readonly<Partial<Record<ModelTranslationIngress, ReadonlyArray<Readonly<ModelTranslationRule>>>>>

/**
 * One request's frozen view of `model_translation`.
 *
 * `snapshotId` is content-addressed, not per-request: two requests decided against the same config
 * legitimately share an identity, and the id changing is exactly the signal that the config moved.
 * It is derived from the serialized view, so it inherits that view's key order — a config re-parsed
 * into a different key order would hash differently. Rules come from one YAML parse, so in practice
 * the order is stable.
 */
export type TranslationConfigSnapshot = Readonly<{
  snapshotId: string
  capturedAtMs: number
  modelTranslation: FrozenModelTranslation
}>

/** Deep-copy and freeze, so neither a later `updateState` nor a careless consumer can move it. */
function freezeModelTranslation(source: ModelTranslation): FrozenModelTranslation {
  const out: Record<string, unknown> = {}
  for (const [ingress, rules] of Object.entries(source)) {
    out[ingress] = Object.freeze(rules.map((rule) => Object.freeze({ ...rule, features: rule.features ? Object.freeze([...rule.features]) : undefined })))
  }
  return Object.freeze(out) as FrozenModelTranslation
}

/**
 * Keyed on the live `state.modelTranslation` object rather than on its contents.
 *
 * `updateState` replaces that object wholesale with a deep clone on every write, so a new key here
 * means the config generation actually changed — and an unchanged generation costs one map lookup
 * instead of a re-hash on every request.
 */
const byConfigGeneration = new WeakMap<ModelTranslation, Omit<TranslationConfigSnapshot, "capturedAtMs">>()

/** Capture the current config generation. Call once per request, at ingress. */
export function captureTranslationConfigSnapshot(now: number = Date.now()): TranslationConfigSnapshot {
  const live = state.modelTranslation
  const cached = byConfigGeneration.get(live)
  if (cached) return { ...cached, capturedAtMs: now }

  const modelTranslation = freezeModelTranslation(live)
  const digest = createHash("sha256").update(JSON.stringify(modelTranslation)).digest("hex").slice(0, 16)
  const identity = { snapshotId: `mt1-${digest}`, modelTranslation }
  byConfigGeneration.set(live, identity)
  return { ...identity, capturedAtMs: now }
}

/**
 * The Hono context key. Set by the ingress middleware, read by each route's codec construction — the
 * codec pins it onto the envelope but never captures it itself, because by the time a codec runs the
 * request is already past the point where "which config generation is this" has one answer.
 */
const CONTEXT_KEY = "translationConfigSnapshot"

export function setTranslationConfigSnapshot(c: Context, snapshot: TranslationConfigSnapshot): void {
  c.set(CONTEXT_KEY, snapshot)
}

export function readTranslationConfigSnapshot(c: Context): TranslationConfigSnapshot | undefined {
  return c.get(CONTEXT_KEY) as TranslationConfigSnapshot | undefined
}
