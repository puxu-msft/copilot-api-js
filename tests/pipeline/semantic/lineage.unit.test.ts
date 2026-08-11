import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { TranslationConfigSnapshot } from "../../../src/lib/pipeline/semantic/config-snapshot"
import type { ModelIdentity } from "../../../src/lib/pipeline/semantic/types"

import {
  //
  causeStartsNewSegment,
  createCandidateLineage,
} from "../../../src/lib/pipeline/semantic/lineage"
import {
  //
  resolvePairPolicy,
  SAFE_DEFAULT_POLICY,
} from "../../../src/lib/pipeline/semantic/policy-resolver"
import { asSegmentId } from "../../../src/lib/pipeline/semantic/types"

const ANTHROPIC: ModelIdentity = { protocol: "anthropic", provider: "copilot", model: "claude-sonnet-4" }
const RESPONSES: ModelIdentity = { protocol: "responses", provider: "copilot", model: "gpt-5.6-sol" }
const OTHER_TARGET: ModelIdentity = { protocol: "responses", provider: "copilot", model: "gpt-5.5" }

function snapshotWith(rules: TranslationConfigSnapshot["modelTranslation"]): TranslationConfigSnapshot {
  return { snapshotId: "mt1-testsnapshot", capturedAtMs: 1_000, modelTranslation: rules }
}

describe("pair policy resolution (RFC §6)", () => {
  test("an unmatched pair gets the closed-end safe defaults, not a permissive one", () => {
    const resolution = resolvePairPolicy(snapshotWith({}), ANTHROPIC, RESPONSES)

    expect(resolution.kind).toBe("resolved")
    if (resolution.kind !== "resolved") return
    expect(resolution.policy.carrierFallback).toBe("reject")
    expect(resolution.policy.structuredOutput).toEqual({ mode: "strict" })
    expect(resolution.policy.contextManagement).toEqual({ mode: "reject" })
    expect(resolution.policy.matchedRuleId).toBeUndefined()
    expect(resolution.policy.configSnapshotId).toBe("mt1-testsnapshot")
  })

  test("matching is against the final routed target, keyed by the source's ingress", () => {
    const snapshot = snapshotWith({ "anthropic-messages": [{ match: "gpt-5.6-sol@openai-responses", features: ["strip-thinking-signature"] }] })

    const hit = resolvePairPolicy(snapshot, ANTHROPIC, RESPONSES)
    expect(hit.kind === "resolved" && hit.policy.carrierFallback).toBe("strip")
    expect(hit.kind === "resolved" && hit.policy.matchedRuleId).toBe("gpt-5.6-sol@openai-responses")

    // Same snapshot, a candidate that routed elsewhere: the rule must not follow it.
    const miss = resolvePairPolicy(snapshot, ANTHROPIC, OTHER_TARGET)
    expect(miss.kind === "resolved" && miss.policy.carrierFallback).toBe("reject")
    expect(miss.kind === "resolved" && miss.policy.matchedRuleId).toBeUndefined()
  })

  test("a rule under a different ingress does not leak across", () => {
    const snapshot = snapshotWith({ "openai-responses": [{ match: "gpt-5.6-sol@openai-responses", features: ["strip-thinking-signature"] }] })

    // Source is Anthropic, so the `anthropic-messages` list is the one consulted — and it is empty.
    const resolution = resolvePairPolicy(snapshot, ANTHROPIC, RESPONSES)
    expect(resolution.kind === "resolved" && resolution.policy.carrierFallback).toBe("reject")
  })

  test("a matched rule that stays silent about an axis keeps that axis at its default", () => {
    const snapshot = snapshotWith({ "anthropic-messages": [{ match: "gpt-5.6-sol@openai-responses" }] })
    const resolution = resolvePairPolicy(snapshot, ANTHROPIC, RESPONSES)

    expect(resolution.kind).toBe("resolved")
    if (resolution.kind !== "resolved") return
    // Matched, so it is attributable...
    expect(resolution.policy.matchedRuleId).toBe("gpt-5.6-sol@openai-responses")
    // ...but silence is not permission.
    expect(resolution.policy.carrierFallback).toBe(SAFE_DEFAULT_POLICY.carrierFallback)
    expect(resolution.policy.structuredOutput).toEqual(SAFE_DEFAULT_POLICY.structuredOutput)
  })

  test("re-resolving a route change yields a new policy and leaves the ancestor's untouched", () => {
    const snapshot = snapshotWith({ "anthropic-messages": [{ match: "gpt-5.6-sol@openai-responses", features: ["strip-thinking-signature"] }] })

    const ancestor = resolvePairPolicy(snapshot, ANTHROPIC, RESPONSES)
    const descendant = resolvePairPolicy(snapshot, ANTHROPIC, OTHER_TARGET)

    expect(ancestor.kind === "resolved" && ancestor.policy.carrierFallback).toBe("strip")
    expect(descendant.kind === "resolved" && descendant.policy.carrierFallback).toBe("reject")
    // Same frozen snapshot on both sides: a route change must not be able to rewrite what the ancestor already resolved.
    expect(ancestor.kind === "resolved" && descendant.kind === "resolved" && ancestor.policy.configSnapshotId === descendant.policy.configSnapshotId).toBe(true)
    expect(Object.isFrozen(ancestor.kind === "resolved" ? ancestor.policy : {})).toBe(true)
  })
})

describe("candidate lineage (RFC §6)", () => {
  const policy = (() => {
    const r = resolvePairPolicy(snapshotWith({}), ANTHROPIC, RESPONSES)
    if (r.kind !== "resolved") throw new Error("fixture policy did not resolve")
    return r.policy
  })()

  test("a candidate is born without delivery authority", () => {
    const lineage = createCandidateLineage({ candidateId: "c1", dispatchId: "d1", segmentId: asSegmentId("s1"), cause: "primary", policy })

    expect(lineage.deliveryAuthority).toEqual({ kind: "uncommitted" })
    expect(lineage.configSnapshotId).toBe(policy.configSnapshotId)
    expect(lineage.parentCandidateId).toBeUndefined()
  })

  test("a descendant records its parent and cause", () => {
    const lineage = createCandidateLineage({
      candidateId: "c2",
      dispatchId: "d2",
      segmentId: asSegmentId("s2"),
      cause: "continuation",
      policy,
      parentCandidateId: "c1",
      parentSegmentId: asSegmentId("s1"),
    })

    expect(lineage.cause).toBe("continuation")
    expect(lineage.parentCandidateId).toBe("c1")
    expect(lineage.parentSegmentId).toBe(asSegmentId("s1"))
  })

  test("only fallback and continuation open a segment — a race decides authority, it does not create one", () => {
    expect(causeStartsNewSegment("fallback")).toBe(true)
    expect(causeStartsNewSegment("continuation")).toBe(true)
    expect(causeStartsNewSegment("hedge")).toBe(false)
    expect(causeStartsNewSegment("retry")).toBe(false)
    expect(causeStartsNewSegment("primary")).toBe(false)
  })
})
