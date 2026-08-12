/**
 * C2.2 接线的行为验收：lineage 必须由**生产路径**登记，而不只是被单测直接 `new` 出来。
 *
 * 独立评审 (`docs/tmp/2026-08-12-c2-2-review.md` MAJOR-1) 指出：`lineage-registry.unit.test.ts` 全部直接调用
 * `createCandidateLineageRegistry()`，于是把 `driver.ts` 里唯一那行 `candidateLineageFor(env.ctx).register(...)`
 * 删掉，那批测试仍然全绿——接线本身零判别力。本文件就是补这一刀：断言全部经由真实
 * `createPipelineDriver().runRequest()` 之后从 `candidateLineageFor(ctx)` 读出，删掉那行接线即变红。
 *
 * 顺带把两条粒度断言做成**行为**判据，而不只是类型上的说明：
 * - 一次 retry 会产生第二个 dispatch 而**不是**第二个 candidate，所以记录数不变（RFC §6，`LineageCause` 无 `retry` 的理由）。
 * - 非 bridge pair 的请求不产生 recorded lineage（RFC §2 的作用域）。
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestContext } from "~/lib/context/request"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { TranslationConfigSnapshot } from "~/lib/pipeline/semantic/config-snapshot"
import type {
  //
  FormatCodec,
  PreparedRequest,
  RetryStrategy,
  RouteDecision,
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"
import { candidateLineageFor } from "~/lib/pipeline/semantic/lineage-registry"
import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

const saved = snapshotStateForTests()
afterEach(() => {
  restoreStateForTests(saved)
})

const SNAPSHOT: TranslationConfigSnapshot = {
  snapshotId: "mt1-wiring",
  capturedAtMs: 1_000,
  modelTranslation: { "anthropic-messages": [{ match: "gpt-5.6-sol@openai-responses", features: ["strip-thinking-signature"] }] },
}

function makeCtx(): RequestContext {
  return {
    operationSignal: new AbortController().signal,
    beginAttempt: () => {},
    transition: () => {},
    setAttemptError: () => {},
    recordAttemptFailure: () => {},
    setSseEvents: () => {},
    setHttpHeaders: () => {},
    setAttemptEffectiveRequest: () => {},
    setAttemptWireRequest: () => {},
    setAttemptCacheControlStripped: () => {},
    recordFeature: () => {},
    addQueueWaitMs: () => {},
  } as unknown as RequestContext
}

/** `bridge: false` routes an Anthropic client to the Chat-Completions leg, which RFC §2 puts outside the bridge. */
function makeEnv(ctx: RequestContext, options: Readonly<{ bridge: boolean; snapshot?: TranslationConfigSnapshot }>): RequestEnvelope {
  return {
    request: {
      clientFormat: "anthropic",
      model: { id: "gpt-5.6-sol" },
      stream: true,
      ...(options.snapshot !== undefined && { translationConfigSnapshot: options.snapshot }),
    },
    attempt: { body: {}, targetEndpoint: options.bridge ? "/responses" : "/chat/completions", prepareHints: {} },
    candidate: {},
    view: {},
    ctx,
    createView: () => ({}),
  } as unknown as RequestEnvelope
}

async function* gen<T>(items: Array<T>): AsyncIterable<T> {
  for (const item of items) yield item
}

function okStream(frames: Array<UpstreamFrame> = []): UpstreamStream {
  return { frames: gen(frames), headers: new Headers() }
}

function makeCodec(env: RequestEnvelope): FormatCodec & { decideRoute: (env: RequestEnvelope) => RouteDecision } {
  const base: FormatCodec = {
    format: "anthropic",
    parse: () => env,
    translateOut: (current) => current,
    prepareWire: () => ({ url: "u", headers: new Headers(), body: {}, stream: true }) as PreparedRequest,
    renderResponse: (frame) => frame,
    renderResponseNonStreaming: (upstream) => ({ rendered: upstream }),
    formatError: () => ({ event: "error", data: "{}" }),
    createResponseAccumulator: () => ({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" }),
  }
  return Object.assign(base, { decideRoute: () => ({ kind: "passthrough", endpoint: env.attempt.targetEndpoint }) as RouteDecision })
}

const BASE: Omit<DriverDeps, "codec" | "transport"> = { strategies: [], maxRetries: 3, maxLearningRetries: 32 }

describe("candidate lineage is recorded by the production driver path (RFC §6, C2.2)", () => {
  test("a bridge request records exactly one lineage, resolved from the request's own snapshot", async () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })
    const ctx = makeCtx()
    const env = makeEnv(ctx, { bridge: true, snapshot: SNAPSHOT })
    const codec = makeCodec(env)
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: { send: async () => okStream() } as Transport })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })
    expect(result.ok).toBe(true)

    const recorded = candidateLineageFor(ctx).recorded()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.cause).toBe("primary")
    expect(recorded[0]?.deliveryAuthority).toEqual({ kind: "uncommitted" })
    // Resolved from THIS request's frozen snapshot, not from live state — the rule below only exists in SNAPSHOT.
    expect(recorded[0]?.configSnapshotId).toBe("mt1-wiring")
    expect(recorded[0]?.policy.carrierFallback).toBe("strip")
    expect(recorded[0]?.policy.source.protocol).toBe("anthropic")
    expect(recorded[0]?.policy.target.protocol).toBe("responses")
  })

  /**
   * The behavioural form of why `LineageCause` has no `retry`: a retry opens a new DISPATCH under the
   * same candidate. If the record count grew here, either the wiring moved to dispatch granularity or
   * a retry started minting candidates — both would silently corrupt the lineage chain.
   */
  test("a retry adds a dispatch, not a candidate, so the record count does not grow", async () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })
    const ctx = makeCtx()
    const env = makeEnv(ctx, { bridge: true, snapshot: SNAPSHOT })
    const codec = makeCodec(env)

    let attempts = 0
    const transport = {
      send: async () => {
        attempts++
        if (attempts === 1) throw new Error("boom")
        return okStream()
      },
    } as Transport
    const strategy: RetryStrategy = { name: "test-retry", canHandle: () => true, handle: async (_error, current) => ({ kind: "retry", env: current }) }

    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport, strategies: [strategy] })
    const result = await driver.runRequest({ body: {}, headers: new Headers() })

    expect(result.ok).toBe(true)
    expect(attempts).toBe(2)
    expect(candidateLineageFor(ctx).recorded()).toHaveLength(1)
  })

  /** RFC §2 scope. An Anthropic client on the Chat-Completions leg is not a bridge pair, so it gets no policy. */
  test("a non-bridge request records no lineage", async () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })
    const ctx = makeCtx()
    const env = makeEnv(ctx, { bridge: false, snapshot: SNAPSHOT })
    const codec = makeCodec(env)
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: { send: async () => okStream() } as Transport })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })
    expect(result.ok).toBe(true)
    expect(candidateLineageFor(ctx).recorded()).toEqual([])
  })

  /** Two requests are two records, each on its own ctx — proves the registry is per-request rather than process-global. */
  test("separate requests do not share a lineage record", async () => {
    setStateForTests({ ghcApiBaseUrl: "", accountType: "individual" })
    const first = makeCtx()
    const second = makeCtx()

    for (const ctx of [first, second]) {
      const env = makeEnv(ctx, { bridge: true, snapshot: SNAPSHOT })
      const codec = makeCodec(env)
      const driver = createPipelineDriver({
        ...BASE,
        codec,
        decideRoute: (e) => codec.decideRoute(e),
        transport: { send: async () => okStream() } as Transport,
      })
      expect((await driver.runRequest({ body: {}, headers: new Headers() })).ok).toBe(true)
    }

    expect(candidateLineageFor(first).recorded()).toHaveLength(1)
    expect(candidateLineageFor(second).recorded()).toHaveLength(1)
    expect(candidateLineageFor(first).recorded()[0]?.candidateId).not.toBe(candidateLineageFor(second).recorded()[0]?.candidateId as never)
  })
})
