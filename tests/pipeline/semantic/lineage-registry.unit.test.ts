import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

import type { CandidateHandle } from "../../../src/lib/context/model-operation-record"
import type {
  //
  ClientFormat,
  RequestEnvelope,
  UpstreamEndpoint,
} from "../../../src/lib/pipeline/envelope"
import type { TranslationConfigSnapshot } from "../../../src/lib/pipeline/semantic/config-snapshot"

import { makeEnvelope } from "../../../src/lib/pipeline/envelope"
import { createCandidateLineageRegistry } from "../../../src/lib/pipeline/semantic/lineage-registry"
import { asSegmentId } from "../../../src/lib/pipeline/semantic/types"
import {
  //
  mockModel,
  mockRequestContext,
} from "../../helpers/factories"

const saved = snapshotStateForTests()
afterEach(() => {
  restoreStateForTests(saved)
})

const EMPTY_VIEW = { messages: [], tools: [], system: undefined, summary: { messageCount: 0, hasTools: false, hasThinking: false, hasImages: false } }

function snapshotWith(rules: TranslationConfigSnapshot["modelTranslation"]): TranslationConfigSnapshot {
  return { snapshotId: "mt1-testsnapshot", capturedAtMs: 1_000, modelTranslation: rules }
}

function envelopeFor(
  options: Readonly<{
    clientFormat?: ClientFormat
    targetEndpoint?: UpstreamEndpoint
    model?: string
    translationConfigSnapshot?: TranslationConfigSnapshot
  }> = {},
): RequestEnvelope {
  return makeEnvelope({
    request: {
      clientFormat: options.clientFormat ?? "anthropic",
      model: mockModel(options.model ?? "gpt-5.6-sol"),
      stream: true,
      ...(options.translationConfigSnapshot !== undefined && { translationConfigSnapshot: options.translationConfigSnapshot }),
    },
    attempt: { body: {}, targetEndpoint: options.targetEndpoint ?? "/responses", prepareHints: {} },
    ctx: mockRequestContext(),
    createView: () => EMPTY_VIEW,
  })
}

const C1 = "c1" as CandidateHandle
const C2 = "c2" as CandidateHandle

describe("candidate lineage registry (RFC §6, slice C2.2)", () => {
  test("a bridge candidate gets a frozen lineage resolved from the request's snapshot", () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })
    const registry = createCandidateLineageRegistry()

    const outcome = registry.register({
      candidate: C1,
      role: "primary",
      env: envelopeFor({ translationConfigSnapshot: snapshotWith({}) }),
      segmentId: asSegmentId("s1"),
    })

    expect(outcome.kind).toBe("recorded")
    if (outcome.kind !== "recorded") return
    expect(outcome.lineage.candidateId).toBe(C1)
    expect(outcome.lineage.cause).toBe("primary")
    expect(outcome.lineage.configSnapshotId).toBe("mt1-testsnapshot")
    expect(outcome.lineage.deliveryAuthority).toEqual({ kind: "uncommitted" })
    expect(outcome.lineage.policy.source.protocol).toBe("anthropic")
    expect(outcome.lineage.policy.target.protocol).toBe("responses")
    expect(registry.lineageOf(C1)).toBe(outcome.lineage)
  })

  /**
   * `recovery` is the repository's name for RFC §6's PRE-commit fallback, so the translation widens
   * rather than renames. Getting this wrong would make a fallback boundary look like a plain retry in
   * History, and only fallback/continuation open a new segment.
   */
  test("a recovery candidate is recorded as a fallback, and carries its parent", () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })
    const registry = createCandidateLineageRegistry()
    const env = envelopeFor({ translationConfigSnapshot: snapshotWith({}) })

    registry.register({ candidate: C1, role: "primary", env, segmentId: asSegmentId("s1") })
    const outcome = registry.register({
      candidate: C2,
      role: "recovery",
      env,
      segmentId: asSegmentId("s2"),
      parentCandidate: C1,
      parentSegmentId: asSegmentId("s1"),
    })

    expect(outcome.kind === "recorded" && outcome.lineage.cause).toBe("fallback")
    expect(outcome.kind === "recorded" && outcome.lineage.parentCandidateId).toBe(C1)
    expect(registry.recorded().map((lineage) => lineage.candidateId)).toEqual([C1, C2])
  })

  /**
   * The two non-recorded arms are STORED. An absent lineage must stay distinguishable from a
   * candidate nobody registered — otherwise a diagnostic reading "no policy" cannot tell "out of
   * scope by design" from "we forgot to wire this leg".
   */
  test("an out-of-scope candidate records WHY it has no policy rather than vanishing", () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })
    const registry = createCandidateLineageRegistry()

    const noSnapshot = registry.register({ candidate: C1, role: "primary", env: envelopeFor(), segmentId: asSegmentId("s1") })
    expect(noSnapshot).toEqual({ kind: "out-of-scope", reason: "no-config-snapshot" })

    const notABridge = registry.register({
      candidate: C2,
      role: "primary",
      env: envelopeFor({ clientFormat: "gemini", translationConfigSnapshot: snapshotWith({}) }),
      segmentId: asSegmentId("s1"),
    })
    expect(notABridge).toEqual({ kind: "out-of-scope", reason: "not-a-bridge-pair" })

    expect(registry.outcomeOf(C2)).toEqual(notABridge)
    expect(registry.lineageOf(C2)).toBeUndefined()
    expect(registry.recorded()).toEqual([])
  })

  /** RFC §6: an ancestor's policy is never rewritten. A silent overwrite is the one failure that would be invisible afterwards. */
  test("re-registering the same candidate throws instead of replacing its frozen policy", () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })
    const registry = createCandidateLineageRegistry()
    const env = envelopeFor({ translationConfigSnapshot: snapshotWith({}) })

    registry.register({ candidate: C1, role: "primary", env, segmentId: asSegmentId("s1") })
    expect(() => registry.register({ candidate: C1, role: "hedge", env, segmentId: asSegmentId("s2") })).toThrow(/already registered/)
    expect(registry.lineageOf(C1)?.cause).toBe("primary")
  })

  /** A matched rule must reach the stored policy — otherwise the registry would look healthy while every candidate silently ran on safe defaults. */
  test("a matching rule's policy lands on the lineage", () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })
    const registry = createCandidateLineageRegistry()
    const snapshot = snapshotWith({ "anthropic-messages": [{ match: "gpt-5.6-sol@openai-responses", features: ["strip-thinking-signature"] }] })

    const outcome = registry.register({
      candidate: C1,
      role: "primary",
      env: envelopeFor({ translationConfigSnapshot: snapshot }),
      segmentId: asSegmentId("s1"),
    })

    expect(outcome.kind === "recorded" && outcome.lineage.policy.carrierFallback).toBe("strip")
    expect(outcome.kind === "recorded" && outcome.lineage.policy.matchedRuleId).toBe("gpt-5.6-sol@openai-responses")
  })
})
