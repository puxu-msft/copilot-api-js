import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { BetaProbe } from "~/lib/anthropic/pipeline"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { RequestState } from "~/lib/pipeline/request-state"

import { createCandidateStateFactory } from "~/lib/pipeline/generation/candidate-state"

function betaProbe(label: string): BetaProbe {
  let outbound: Array<string> = []
  return {
    recordOutbound(headers) {
      outbound = headers["anthropic-beta"]?.split(",") ?? []
    },
    getCandidates() {
      return [label, ...outbound]
    },
  }
}

function envelope(requestState?: RequestState): RequestEnvelope {
  const body = { model: "model", messages: [{ role: "user", content: "hello" }] }
  const env = {
    clientFormat: "anthropic" as const,
    targetEndpoint: "/v1/messages" as const,
    model: { id: "model" },
    stream: true,
    body,
    view: { messages: [], tools: [], system: undefined, summary: { messageCount: 1, hasTools: false, hasThinking: false, hasImages: false } },
    prepareHints: { excludeBetas: ["initial"] },
    requestState,
    ctx: {},
    with(patch: Record<string, unknown>) {
      return Object.assign(Object.create(Object.getPrototypeOf(this)), this, patch)
    },
  }
  return env as unknown as RequestEnvelope
}

describe("P1-T2 candidate state fork contract", () => {
  test("deep-snapshots generation values and creates isolated candidate-local mutable supplies", () => {
    const sourceBaseline = { messages: [{ role: "user", content: { text: "baseline" } }] }
    const sourceHeaders = { "anthropic-beta": "seed-beta" }
    const sourceSanitization = { stats: { removed: 1 } }
    const sourcePreprocess = { strippedReadTagCount: 1, dedupedToolCallCount: 0 }
    const sourceState: RequestState = {
      truncateBaseline: sourceBaseline,
      resanitize: (payload) => payload,
      betaProbe: betaProbe("source"),
      clientAnthropicBeta: "seed-beta",
      clientRequestHeaders: sourceHeaders,
      initialSanitizationInfo: sourceSanitization,
      preprocessInfo: sourcePreprocess,
      reverseMapperHolder: { source: true },
      responsesFallbackScratch: { source: true },
    }
    let reverseSeq = 0
    let fallbackSeq = 0
    let responseSeq = 0
    const factory = createCandidateStateFactory(envelope(sourceState), {
      createBetaProbe: (seed) => betaProbe(`candidate:${seed}`),
      createReverseMapperHolder: () => ({ id: ++reverseSeq }),
      createResponsesFallbackScratch: () => ({ id: ++fallbackSeq }),
      createResanitize:
        ({ reverseMapperHolder }) =>
        (payload) => ({ payload, reverseMapperHolder }),
      createResponseState: () => ({ id: ++responseSeq }),
    })

    sourceBaseline.messages[0].content.text = "mutated-after-snapshot"
    sourceHeaders["anthropic-beta"] = "mutated-after-snapshot"
    sourceSanitization.stats.removed = 9
    sourcePreprocess.strippedReadTagCount = 9

    const primary = factory.fork({ candidateId: "primary", role: "primary" })
    const hedge = factory.fork({ candidateId: "hedge-1", role: "hedge" })

    expect(primary.body).toEqual({ model: "model", messages: [{ role: "user", content: "hello" }] })
    expect(primary.body).toBe(hedge.body)
    expect(Object.isFrozen(primary.body as object)).toBe(true)
    expect(primary.prepareHints).toEqual({ excludeBetas: ["initial"] })
    expect(primary.prepareHints).not.toBe(hedge.prepareHints)

    expect(primary.requestState?.truncateBaseline).toEqual({ messages: [{ role: "user", content: { text: "baseline" } }] })
    expect(Object.isFrozen(primary.requestState?.truncateBaseline as object)).toBe(true)
    expect(primary.requestState?.clientRequestHeaders).toEqual({ "anthropic-beta": "seed-beta" })
    expect(primary.requestState?.clientAnthropicBeta).toBe("seed-beta")
    expect(primary.requestState?.initialSanitizationInfo).toEqual({ stats: { removed: 1 } })
    expect(primary.requestState?.preprocessInfo).toEqual({ strippedReadTagCount: 1, dedupedToolCallCount: 0 })

    expect(primary.requestState?.betaProbe).not.toBe(hedge.requestState?.betaProbe)
    primary.requestState?.betaProbe?.recordOutbound({ "anthropic-beta": "primary-only" })
    expect(primary.requestState?.betaProbe?.getCandidates()).toEqual(["candidate:seed-beta", "primary-only"])
    expect(hedge.requestState?.betaProbe?.getCandidates()).toEqual(["candidate:seed-beta"])

    expect(primary.requestState?.reverseMapperHolder).toEqual({ id: 1 })
    expect(hedge.requestState?.reverseMapperHolder).toEqual({ id: 2 })
    expect(primary.requestState?.responsesFallbackScratch).toEqual({ id: 1 })
    expect(hedge.requestState?.responsesFallbackScratch).toEqual({ id: 2 })
    expect(primary.responseState).toEqual({ id: 1 })
    expect(hedge.responseState).toEqual({ id: 2 })
    expect(primary.requestState?.resanitize?.("payload")).toEqual({ payload: "payload", reverseMapperHolder: { id: 1 } })
  })

  test("fails explicitly instead of sharing an opaque mutable supply without a candidate factory", () => {
    expect(() => createCandidateStateFactory(envelope({ betaProbe: betaProbe("source") }), {})).toThrow(/createBetaProbe/)
    expect(() => createCandidateStateFactory(envelope({ reverseMapperHolder: {} }), {})).toThrow(/createReverseMapperHolder/)
    expect(() => createCandidateStateFactory(envelope({ responsesFallbackScratch: {} }), {})).toThrow(/createResponsesFallbackScratch/)
    expect(() => createCandidateStateFactory(envelope({ resanitize: (payload) => payload }), {})).toThrow(/createResanitize/)
  })

  test("forks formats without requestState and keeps the stable body shared", () => {
    const factory = createCandidateStateFactory(envelope(), {})
    const primary = factory.fork({ candidateId: "primary", role: "primary" })
    const hedge = factory.fork({ candidateId: "hedge", role: "hedge" })

    expect(primary.requestState).toBeUndefined()
    expect(hedge.requestState).toBeUndefined()
    expect(primary.body).toBe(hedge.body)
    expect(primary.prepareHints).not.toBe(hedge.prepareHints)
  })

  test("fails with a named boundary when generation JSON cannot be snapshotted", () => {
    const env = envelope()
    env.body = { unsupported: () => undefined }
    expect(() => createCandidateStateFactory(env, {})).toThrow(/body must be structured-cloneable/)
  })
})
