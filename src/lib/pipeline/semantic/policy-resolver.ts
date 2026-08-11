/**
 * Per-candidate `PairTranslationPolicy` resolution — RFC §6.
 *
 * One request is decided against one config generation. C2.1 froze that generation into a
 * {@link TranslationConfigSnapshot} at ingress; this module turns it, plus a candidate's final
 * source/target identity, into the policy that candidate translates under. A hot reload may only
 * affect later requests, so nothing here ever reads live state.
 *
 * Resolution happens **after** the final route is known and **once per candidate**: a candidate that
 * changes route (fallback, or a continuation onto a different model) is a new candidate with its own
 * policy, and its ancestor's policy is never rewritten.
 */

import type {
  //
  ModelTranslationIngress,
  ModelTranslationRule,
} from "~/lib/state-vocabulary"

import { findTranslationRule } from "~/lib/config/model-translation"

import type { TranslationConfigSnapshot } from "./config-snapshot"
import type { ModelIdentity } from "./types"

/**
 * The resolved per-pair policy.
 *
 * `[hard]` RFC §6 also lists a `serverTools: ServerToolCapabilities` field. **That type is not
 * defined anywhere in the repo** — `ServerToolCapabilities` appears exactly once, in the RFC's own
 * type block, with no definition. Its semantics belong to §7's server-tool four cells, which C5
 * owns, so inventing a shape here would freeze a contract in the wrong slice. The field is
 * deliberately absent until C5 defines it; registered in `docs/todo/deferred-backlog.md`.
 */
export type PairTranslationPolicy = Readonly<{
  source: ModelIdentity
  target: ModelIdentity
  carrierFallback: "preserve" | "strip" | "reject"
  structuredOutput: Readonly<{ mode: "strict" } | { mode: "allow-unconstrained" }>
  contextManagement: Readonly<{ mode: "reject" } | { mode: "warn-drop" } | { mode: "threshold-only" }>
  configSnapshotId: string
  matchedRuleId?: string
}>

/**
 * RFC §6.2's global safe defaults, used both when no rule matches and when a matched valid rule
 * omits an optional field. They are deliberately the closed end of each axis: a pair nobody has
 * spoken about should fail loudly rather than quietly translate under a permissive setting.
 */
export const SAFE_DEFAULT_POLICY = {
  carrierFallback: "reject",
  structuredOutput: { mode: "strict" },
  contextManagement: { mode: "reject" },
} as const

/**
 * Resolution can fail without falling back.
 *
 * RFC §6.2: a request that matches only an **invalid** rule gets a stable typed error — matching an
 * invalid rule is *not* the same as matching nothing, and must never silently become a
 * default-looking policy. v1 rules are zod-validated at parse time so this arm is unreachable today;
 * it exists because C6.2 introduces v2 rules that can be rejected wholesale, and the alternative is
 * a resolver whose signature cannot express the outcome C6.2 needs.
 */
export type PolicyResolution =
  | Readonly<{ kind: "resolved"; policy: PairTranslationPolicy }>
  | Readonly<{ kind: "config-error"; matchedRuleId: string; code: "rule-invalid" }>

/** The bridge covers Anthropic ↔ Responses only (RFC §2 rules out Gemini and the real CC leg). */
function ingressForProtocol(protocol: ModelIdentity["protocol"]): ModelTranslationIngress {
  return protocol === "anthropic" ? "anthropic-messages" : "openai-responses"
}

/**
 * A rule's stable identity for History and diagnostics.
 *
 * v1 rules carry no explicit id, so the `match` string is the identity — it is unique per ingress by
 * construction, since the matcher takes the first exact hit and any later duplicate is unreachable.
 */
function ruleIdOf(rule: ModelTranslationRule): string {
  return rule.match
}

/**
 * Resolve one candidate's policy from the request's frozen snapshot.
 *
 * `source` is the client's side of the pair; `target` is the **final routed** upstream — never the
 * client's raw requested model name, which is what the existing feature matcher already documents.
 */
export function resolvePairPolicy(snapshot: TranslationConfigSnapshot, source: ModelIdentity, target: ModelIdentity): PolicyResolution {
  const ingress = ingressForProtocol(source.protocol)
  const rules = snapshot.modelTranslation[ingress]
  const matched = findTranslationRule(rules, target.model, ingressForProtocol(target.protocol))

  const base = {
    source,
    target,
    configSnapshotId: snapshot.snapshotId,
    ...SAFE_DEFAULT_POLICY,
  }

  if (!matched) return { kind: "resolved", policy: Object.freeze(base) }

  // v1's only feature is the documented input-compat alias for `policy.carrier_unknown: "strip"` (RFC §6.2). Everything else keeps the safe default: a matched rule that stays silent about an axis is not a permission to relax it.
  const carrierFallback = matched.features?.includes("strip-thinking-signature") ? "strip" : SAFE_DEFAULT_POLICY.carrierFallback

  return {
    kind: "resolved",
    policy: Object.freeze({ ...base, carrierFallback, matchedRuleId: ruleIdOf(matched) }),
  }
}
