import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { BetaProbe } from "~/lib/anthropic/pipeline"
import type {
  //
  CandidateScope,
  RequestEnvelope,
  RequestScope,
} from "~/lib/pipeline/envelope"

import { createCandidateStateFactory } from "~/lib/pipeline/generation/candidate-state"
import { createToolNameMapper } from "~/lib/tool-name-mapper"

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

function envelope(candidate: CandidateScope = {}, request: Partial<RequestScope> = {}): RequestEnvelope {
  const body = { model: "model", messages: [{ role: "user", content: "hello" }] }
  return {
    request: { clientFormat: "anthropic", model: { id: "model" }, stream: true, ...request } as RequestScope,
    candidate,
    attempt: { body, targetEndpoint: "/v1/messages", prepareHints: { excludeBetas: ["initial"] } },
    view: { messages: [], tools: [], system: undefined, summary: { messageCount: 1, hasTools: false, hasThinking: false, hasImages: false } },
    ctx: {},
    createView: () => ({}),
  } as unknown as RequestEnvelope
}

describe("P1-T2 candidate state fork contract", () => {
  test("snapshots the generation body once and gives every candidate its own copy plus isolated mutable supplies", () => {
    const sourceToolNameMapper = createToolNameMapper(["my/tool"], { allowDots: false, maxNameLength: 128 })
    const sourceCandidate: CandidateScope = {
      resanitize: (payload) => payload,
      betaProbe: betaProbe("source"),
      reverseMapperHolder: { source: true },
      responsesFallbackScratch: { source: true },
    }
    let reverseSeq = 0
    let fallbackSeq = 0
    const env = envelope(sourceCandidate, { clientAnthropicBeta: "seed-beta", sourceToolNameMapper })
    const factory = createCandidateStateFactory(env, {
      createBetaProbe: (seed) => betaProbe(`candidate:${seed}`),
      createReverseMapperHolder: () => ({ id: ++reverseSeq }),
      createResponsesFallbackScratch: () => ({ id: ++fallbackSeq }),
      createResanitize:
        ({ reverseMapperHolder }) =>
        (payload) => ({ payload, reverseMapperHolder }),
    })

    // The generation snapshot is taken when the FACTORY is built, so a later write to the live envelope cannot reach an already-planned candidate.
    ;(env.attempt.body as { model: string }).model = "mutated-after-snapshot"

    const primary = factory.fork({ candidateId: "primary", role: "primary" })
    const hedge = factory.fork({ candidateId: "hedge-1", role: "hedge" })

    expect(primary.body).toEqual({ model: "model", messages: [{ role: "user", content: "hello" }] })
    // Each candidate owns its body. The pre-mutability contract asserted `toBe` here — one deep-frozen body shared by every candidate, kept apart by copy-on-write. With mutable scopes that sharing IS the aliasing this fork exists to prevent, so the invariant is now the opposite one.
    expect(primary.body).not.toBe(hedge.body)
    expect(primary.body).toEqual(hedge.body)
    expect(primary.prepareHints).toEqual({ excludeBetas: ["initial"] })
    expect(primary.prepareHints).not.toBe(hedge.prepareHints)

    // The request scope is NOT part of a fork: it is request-level truth, shared by reference so that a late write (gemini's S1b truncateBaseline) reaches every candidate.
    expect(Object.keys(primary)).toEqual(["candidateId", "role", "body", "prepareHints", "candidate"])
    expect(env.request.sourceToolNameMapper?.toClient("my_tool")).toBe("my/tool")

    expect(primary.candidate.betaProbe).not.toBe(hedge.candidate.betaProbe)
    primary.candidate.betaProbe?.recordOutbound({ "anthropic-beta": "primary-only" })
    expect(primary.candidate.betaProbe?.getCandidates()).toEqual(["candidate:seed-beta", "primary-only"])
    expect(hedge.candidate.betaProbe?.getCandidates()).toEqual(["candidate:seed-beta"])

    expect(primary.candidate.reverseMapperHolder).toEqual({ id: 1 })
    expect(hedge.candidate.reverseMapperHolder).toEqual({ id: 2 })
    expect(primary.candidate.responsesFallbackScratch).toEqual({ id: 1 })
    expect(hedge.candidate.responsesFallbackScratch).toEqual({ id: 2 })
    expect(primary.candidate.resanitize?.("payload")).toEqual({ payload: "payload", reverseMapperHolder: { id: 1 } })
  })

  test("fails explicitly instead of sharing an opaque mutable supply without a candidate factory", () => {
    expect(() => createCandidateStateFactory(envelope({ betaProbe: betaProbe("source") }), {})).toThrow(/createBetaProbe/)
    expect(() => createCandidateStateFactory(envelope({ reverseMapperHolder: {} }), {})).toThrow(/createReverseMapperHolder/)
    expect(() => createCandidateStateFactory(envelope({ responsesFallbackScratch: {} }), {})).toThrow(/createResponsesFallbackScratch/)
    expect(() => createCandidateStateFactory(envelope({ resanitize: (payload) => payload }), {})).toThrow(/createResanitize/)
  })

  test("forks a format that carries no candidate supply at all", () => {
    const factory = createCandidateStateFactory(envelope(), {})
    const primary = factory.fork({ candidateId: "primary", role: "primary" })
    const hedge = factory.fork({ candidateId: "hedge", role: "hedge" })

    expect(primary.candidate).toEqual({})
    expect(hedge.candidate).toEqual({})
    expect(primary.body).not.toBe(hedge.body)
    expect(primary.prepareHints).not.toBe(hedge.prepareHints)
  })

  test("已经产出的 candidate 不受 fork 之后源 body 嵌套写入的影响", () => {
    // 与上面那条的区别是时机：那条在**首次 fork 之前**改源对象，只证明了 factory 建立时取了快照。这条改在 fork **之后**，证明的是产出物与源之间没有残留别名——可变作用域下这是两件事，而此前只有前者有守卫。
    const env = envelope()
    const factory = createCandidateStateFactory(env, {})
    const primary = factory.fork({ candidateId: "primary", role: "primary" })

    const sourceMessages = (env.attempt.body as { messages: Array<{ role?: string; content: string }> }).messages
    sourceMessages[0]!.content = "mutated-after-fork"
    sourceMessages.push({ content: "appended-after-fork" })

    expect((primary.body as { messages: Array<{ role?: string; content: string }> }).messages).toEqual([{ role: "user", content: "hello" }])

    // 之后再 fork 的候选同样只看到源的当前值一次拷贝，且与已有候选互不相干。
    const late = factory.fork({ candidateId: "late", role: "hedge" })
    expect(late.body).not.toBe(primary.body)
    ;(late.body as { messages: Array<{ role?: string; content: string }> }).messages[0]!.content = "written-by-late"
    expect((primary.body as { messages: Array<{ role?: string; content: string }> }).messages[0]?.content).toBe("hello")
  })

  test("fails with a named boundary when generation JSON cannot be snapshotted", () => {
    const env = envelope()
    env.attempt.body = { unsupported: () => undefined }
    expect(() => createCandidateStateFactory(env, {})).toThrow(/body must be structured-cloneable/)
  })
})
