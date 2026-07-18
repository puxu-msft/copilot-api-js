/**
 * P2.1 — PipelineDriver skeleton unit tests. Drives the format-agnostic driver
 * with a mock codec / transport / strategies + a recording ctx, asserting the
 * stage orchestration (S1→S7), the error-driven retry loop (retry-transport §2),
 * the request/response rewrite chains (incl. buffer/flush), reject short-circuit,
 * and the non-streaming variant.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestContext } from "~/lib/context/request"
import type { ApiError } from "~/lib/error"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  FrameAction,
  RequestRewrite,
  ResponseRewrite,
  RewriteState,
} from "~/lib/pipeline/rewrite-registry"
import type {
  //
  ClientFrame,
  ClientSink,
  FormatCodec,
  PreparedRequest,
  RetryStrategy,
  RouteDecision,
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { RetryStrategy as LegacyRetryStrategy } from "~/lib/request/retry-types"

import { HTTPError } from "~/lib/error"
import { makeArraySink } from "~/lib/pipeline/client-sink"
import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"
import { adaptLegacyStrategy } from "~/lib/pipeline/legacy-strategy-adapter"
import { StreamClientAbortError } from "~/lib/stream"
import { UpstreamTransportFallbackError } from "~/lib/transport/fallback"

// ── ctx recorder ──────────────────────────────────────────────────────────

interface CtxCalls {
  beginAttempt: Array<unknown>
  transition: Array<string>
  setAttemptError: Array<ApiError>
  recordAttemptFailure: Array<unknown>
  setSseEvents: Array<unknown>
}

function makeCtx(): { ctx: RequestContext; calls: CtxCalls } {
  const calls: CtxCalls = { beginAttempt: [], transition: [], setAttemptError: [], recordAttemptFailure: [], setSseEvents: [] }
  const ctx = {
    operationSignal: new AbortController().signal,
    beginAttempt: (o: unknown) => calls.beginAttempt.push(o),
    transition: (s: string) => calls.transition.push(s),
    setAttemptError: (e: ApiError) => calls.setAttemptError.push(e),
    recordAttemptFailure: (a: unknown) => calls.recordAttemptFailure.push(a),
    // P3.2b: runResponse samples upstream-original frames here (aliased per-frame).
    setSseEvents: (e: unknown) => calls.setSseEvents.push(e),
    // RFC Phase 2: driver writes outbound header legs during the exchange (success +
    // failure). The mock just no-ops; the header capture itself is covered by the
    // http-headers-capture golden + history integration tests.
    setHttpHeaders: () => {},
    // Per-attempt sampling sinks the driver calls after a cell's sampleWireTrack (write-only no-ops here;
    // the two-track history sampling is covered by the codec/http integration tests).
    setAttemptEffectiveRequest: () => {},
    setAttemptWireRequest: () => {},
    setAttemptCacheControlStripped: () => {},
    recordFeature: () => {},
    addQueueWaitMs: () => {},
  } as unknown as RequestContext
  return { ctx, calls }
}

function makeEnv(ctx: RequestContext, body: unknown = { v: 0 }): RequestEnvelope {
  const env = {
    clientFormat: "openai-cc",
    targetEndpoint: "/chat/completions",
    model: {},
    stream: true,
    body,
    view: {},
    prepareHints: {},
    ctx,
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as unknown as RequestEnvelope
    },
  }
  return env as unknown as RequestEnvelope
}

// ── mock codec / transport / strategies ─────────────────────────────────────

/**
 * A mock codec plus a routing decision. `decideRoute` is NOT a FormatCodec method anymore
 * (it moved to the free-function `router.decideRoute`, ADR 2026-07-11) — these orchestration
 * tests drive routing through the `DriverDeps.decideRoute` DI override, so the mock carries a
 * `decideRoute` closure on a side-channel (via intersection) that the call sites wire in.
 */
type MockCodec = FormatCodec & { decideRoute: (env: RequestEnvelope) => RouteDecision }

function makeCodec(over: Partial<FormatCodec> & { env?: RequestEnvelope; decideRoute?: (env: RequestEnvelope) => RouteDecision } = {}): {
  codec: MockCodec
  spy: Record<string, number>
} {
  const spy: Record<string, number> = { parse: 0, decideRoute: 0, translateOut: 0, prepareWire: 0, renderResponse: 0, renderResponseNonStreaming: 0 }
  const base: FormatCodec = {
    format: "openai-cc",
    parse: (_raw) => {
      spy.parse++
      return over.env ?? makeEnv(makeCtx().ctx)
    },
    translateOut: over.translateOut ?? ((env) => (spy.translateOut++, env)),
    prepareWire: over.prepareWire ?? (() => (spy.prepareWire++, { url: "u", headers: new Headers(), body: {}, stream: true } as PreparedRequest)),
    renderResponse: over.renderResponse ?? ((frame) => (spy.renderResponse++, frame)),
    renderResponseNonStreaming: over.renderResponseNonStreaming ?? ((upstream) => (spy.renderResponseNonStreaming++, { rendered: upstream })),
    formatError: over.formatError ?? ((_err, _env) => ({ event: "error", data: "{}" }) as ClientFrame),
    createResponseAccumulator: over.createResponseAccumulator ?? (() => ({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" })),
  }
  // The routing decision, spy-counted. Wired into the driver via `deps.decideRoute` at each
  // call site (`decideRoute: (e) => codec.decideRoute(e)`).
  const decide = over.decideRoute ?? (() => ({ kind: "passthrough", endpoint: "/chat/completions" }) as RouteDecision)
  const codec = Object.assign(base, { decideRoute: (env: RequestEnvelope) => (spy.decideRoute++, decide(env)) }) as MockCodec
  return { codec, spy }
}

async function* gen<T>(items: Array<T>): AsyncIterable<T> {
  for (const i of items) yield i
}

function makeTransport(send: Transport["send"]): Transport {
  return { send }
}

function okStream(frames: Array<UpstreamFrame> = [], nonStream?: unknown): UpstreamStream {
  return { frames: gen(frames), ...(nonStream !== undefined && { nonStream }), headers: new Headers() }
}

const BASE: Omit<DriverDeps, "codec" | "transport"> = { strategies: [], maxRetries: 3, maxLearningRetries: 32 }

// ── tests ────────────────────────────────────────────────────────────────

describe("driver.runRequest — orchestration", () => {
  test("happy path: parse → decideRoute(passthrough) → translateOut → exchange → ok", async () => {
    const { ctx, calls } = makeCtx()
    const env = makeEnv(ctx)
    const { codec, spy } = makeCodec({ env })
    let sent: PreparedRequest | undefined
    const transport = makeTransport(async (wire) => {
      sent = wire
      return okStream()
    })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })

    expect(result.ok).toBe(true)
    expect(spy.parse).toBe(1)
    expect(spy.decideRoute).toBe(1)
    expect(spy.prepareWire).toBe(1)
    expect(sent?.url).toBe("u")
    expect(calls.transition).toEqual(["executing"])
    expect(calls.beginAttempt).toHaveLength(1)
  })

  test("429 is observed by admission and replayed as an explicit rate-limit dispatch", async () => {
    const { ctx, calls } = makeCtx()
    const env = { ...makeEnv(ctx), model: { id: "model" } as RequestEnvelope["model"] } as RequestEnvelope
    const { codec } = makeCodec({ env })
    let sends = 0
    const transport = makeTransport(async () => {
      sends++
      if (sends === 1) throw new HTTPError("rate limited", 429, JSON.stringify({ retry_after: 0 }))
      return okStream()
    })
    const observations: Array<number | undefined> = []
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport,
      admission: {
        async acquire() {
          return { admittedAt: Date.now(), queueWaitMs: 0 }
        },
        observe(result) {
          observations.push(result.status)
          return result.rateLimited ? { kind: "retry", retryAfterMs: 0, retryAt: Date.now() } : { kind: "complete" }
        },
        rejectAll() {},
      },
    })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })

    expect(result.ok).toBe(true)
    expect(sends).toBe(2)
    expect(calls.beginAttempt).toEqual([{}, { strategy: "rate-limit-retry" }])
    expect(calls.recordAttemptFailure).toEqual([{ willRetry: true, nextStrategy: "rate-limit-retry", waitMs: 0 }])
    expect(observations).toEqual([429, 200])
  })

  test("429 falls through to semantic retry when admission has no retry instruction", async () => {
    const { ctx } = makeCtx()
    const env = { ...makeEnv(ctx), model: { id: "model" } as RequestEnvelope["model"] } as RequestEnvelope
    const { codec } = makeCodec({ env })
    let sends = 0
    const transport = makeTransport(async () => {
      sends++
      if (sends === 1) throw new HTTPError("rate limited", 429, "{}")
      return okStream()
    })
    let handled = 0
    const strategy: RetryStrategy = {
      name: "semantic-rate-limit",
      canHandle: (error) => error.status === 429,
      async handle(_error, current) {
        handled++
        return { kind: "retry", env: current }
      },
    }
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport,
      strategies: [strategy],
      admission: {
        async acquire() {
          return { admittedAt: Date.now(), queueWaitMs: 0 }
        },
        observe() {
          return { kind: "complete" }
        },
        rejectAll() {},
      },
    })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })

    expect(result.ok).toBe(true)
    expect(sends).toBe(2)
    expect(handled).toBe(1)
  })

  test("WS before-first-event fallback starts a separately admitted HTTP dispatch", async () => {
    const { ctx, calls } = makeCtx()
    const env = { ...makeEnv(ctx), model: { id: "model" } as RequestEnvelope["model"] } as RequestEnvelope
    const { codec } = makeCodec({ env })
    const dispatchOptions: Array<unknown> = []
    let sends = 0
    const transport = makeTransport(async (_wire, _env, options) => {
      dispatchOptions.push(options)
      sends++
      if (sends === 1) throw new UpstreamTransportFallbackError("ws-before-first-event", new Error("WS closed before first event"))
      return okStream()
    })
    const admitted: Array<string> = []
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport,
      admission: {
        async acquire(input) {
          admitted.push(input.dispatchId)
          return { admittedAt: Date.now(), queueWaitMs: 0 }
        },
        observe() {
          return { kind: "complete" }
        },
        rejectAll() {},
      },
    })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })

    expect(result.ok).toBe(true)
    expect(sends).toBe(2)
    expect(admitted).toHaveLength(2)
    expect(calls.beginAttempt).toEqual([{}, { strategy: "ws-fallback" }])
    expect(calls.recordAttemptFailure).toEqual([{ willRetry: true, nextStrategy: "ws-fallback" }])
    expect(dispatchOptions).toHaveLength(2)
    expect(dispatchOptions[0]).toMatchObject({ signal: expect.any(AbortSignal) })
    expect(dispatchOptions[1]).toMatchObject({ signal: expect.any(AbortSignal), forceHttp: true })
  })

  test("reject: decideRoute(reject) → ok:false, transport never called", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env, decideRoute: () => ({ kind: "reject", status: 400, reason: "no endpoint" }) })
    let sendCalled = false
    const transport = makeTransport(async () => ((sendCalled = true), okStream()))
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.status).toBe(400)
      expect(result.rejection.reason).toBe("no endpoint")
      expect(result.rejection.format).toBe("openai-cc")
    }
    expect(sendCalled).toBe(false)
  })

  test("translate: targetEndpoint set to decision.to before translateOut", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    let seenEndpoint: string | undefined
    const { codec } = makeCodec({
      env,
      decideRoute: () => ({ kind: "translate", to: "/responses" }),
      translateOut: (e) => {
        seenEndpoint = e.targetEndpoint
        return e
      },
    })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })

    await driver.runRequest({ body: {}, headers: new Headers() })
    expect(seenEndpoint).toBe("/responses")
  })

  test("S3 request rewrites apply in order, transforming env.body", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx, { steps: [] as Array<string> })
    const { codec } = makeCodec({ env })
    const mkRewrite = (name: string, order: number): RequestRewrite => ({
      name,
      order,
      appliesTo: () => true,
      apply: (e) => {
        const body = e.body as { steps: Array<string> }
        return { env: e.with({ body: { steps: [...body.steps, name] } }), changed: true }
      },
    })
    let bodySent: unknown
    const transport = makeTransport(async (_wire, e) => ((bodySent = e.body), okStream()))
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport,
      requestRewrites: [mkRewrite("b", 200), mkRewrite("a", 100)],
    })

    await driver.runRequest({ body: {}, headers: new Headers() })
    expect((bodySent as { steps: Array<string> }).steps).toEqual(["a", "b"])
  })
})

describe("driver.runExchange — error-driven retry", () => {
  test("retries once via a strategy, then succeeds", async () => {
    const { ctx, calls } = makeCtx()
    const env = makeEnv(ctx)
    const { codec, spy } = makeCodec({ env })
    let attempts = 0
    const transport = makeTransport(async () => {
      attempts++
      if (attempts === 1) throw new Error("boom")
      return okStream()
    })
    let onResolved = 0
    const strategy: RetryStrategy = {
      name: "test-retry",
      canHandle: () => true,
      handle: async (_err, e) => ({ kind: "retry", env: e }),
      onResolved: () => {
        onResolved++
      },
    }
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport, strategies: [strategy] })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })
    expect(result.ok).toBe(true)
    expect(attempts).toBe(2)
    expect(spy.prepareWire).toBe(2)
    expect(calls.setAttemptError).toHaveLength(1)
    expect(calls.recordAttemptFailure).toHaveLength(1)
    expect(onResolved).toBe(1)
  })

  test("migrated cell resolves its stack via CellAssembly, NEVER the legacy deps.strategies factory (no double recordFeature)", async () => {
    // Regression for the C4 review HIGH: the S4 exchange (and the buffered re-exchange) must NOT eager-eval
    // deps.strategies for a MIGRATED cell — the legacy per-route factory carries recordFeature side effects
    // (via-responses / via-chat-completions-fallback) that the leg's translateOut now owns, so an eager call
    // would double-fire them on the live observability bus. A migrated env (openai-cc|/chat/completions, a
    // real MIGRATED_CELLS entry, with the leg supply on requestState) drives the REAL chatCompletionsLeg.
    const { ctx } = makeCtx()
    const ccBody = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }
    const migratedEnv = {
      clientFormat: "openai-cc",
      targetEndpoint: "/chat/completions",
      model: { id: "gpt-4o" },
      stream: true,
      body: ccBody,
      view: {},
      prepareHints: {},
      requestState: { truncateBaseline: ccBody },
      ctx,
      with(patch: Partial<RequestEnvelope>): RequestEnvelope {
        return { ...this, ...patch } as unknown as RequestEnvelope
      },
    } as unknown as RequestEnvelope
    const { codec } = makeCodec({ env: migratedEnv })
    let strategyFactoryCalls = 0
    const strategiesFactory = (_e: RequestEnvelope): ReadonlyArray<RetryStrategy> => {
      strategyFactoryCalls++
      return []
    }
    const transport = makeTransport(async () => okStream())
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: () => ({ kind: "passthrough", endpoint: "/chat/completions" }) as RouteDecision,
      transport,
      strategies: strategiesFactory,
    })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })
    expect(result.ok).toBe(true)
    // The migrated cell composed its stack via the CellAssembly → the legacy factory was NEVER evaluated.
    expect(strategyFactoryCalls).toBe(0)
  })

  test("no matching strategy → throws", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    const transport = makeTransport(async () => {
      throw new Error("boom")
    })
    const strategy: RetryStrategy = { name: "nope", canHandle: () => false, handle: async (_e, e) => ({ kind: "retry", env: e }) }
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport, strategies: [strategy] })

    await expect(driver.runRequest({ body: {}, headers: new Headers() })).rejects.toThrow("boom")
  })

  test("normal-budget exhaustion → throws after maxRetries", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    let attempts = 0
    const transport = makeTransport(async () => {
      attempts++
      throw new Error("boom")
    })
    const strategy: RetryStrategy = { name: "always", canHandle: () => true, handle: async (_e, e) => ({ kind: "retry", env: e }) }
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport, strategies: [strategy], maxRetries: 2 })

    await expect(driver.runRequest({ body: {}, headers: new Headers() })).rejects.toThrow("boom")
    // attempt 1 (fail, retry#1) + 2 (fail, retry#2) + 3 (fail, over budget) = 3
    expect(attempts).toBe(3)
  })

  test("learning retries draw from the separate learning budget; recordAttemptFailure carries learning+waitMs", async () => {
    const { ctx, calls } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    let attempts = 0
    const transport = makeTransport(async () => {
      attempts++
      throw new Error("boom")
    })
    const strategy: RetryStrategy = { name: "learner", canHandle: () => true, handle: async (_e, e) => ({ kind: "retry", env: e, learning: true, waitMs: 0 }) }
    // maxRetries:0 would stop a normal retry immediately, but learning retries use
    // maxLearningRetries:2 → fail#1 (0>=2 F) + fail#2 (1>=2 F) + fail#3 (2>=2 T) = 3.
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport,
      strategies: [strategy],
      maxRetries: 0,
      maxLearningRetries: 2,
    })

    await expect(driver.runRequest({ body: {}, headers: new Headers() })).rejects.toThrow("boom")
    expect(attempts).toBe(3)
    expect(calls.recordAttemptFailure).toEqual([
      { willRetry: true, nextStrategy: "learner", waitMs: 0, learning: true },
      { willRetry: true, nextStrategy: "learner", waitMs: 0, learning: true },
    ])
  })

  test("a strategy that throws degrades to the original error (legacy parity)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    const original = new Error("boom")
    const transport = makeTransport(async () => {
      throw original
    })
    const strategy: RetryStrategy = {
      name: "throws",
      canHandle: () => true,
      handle: async () => {
        throw new Error("strategy internal failure")
      },
    }
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport, strategies: [strategy] })

    await expect(driver.runRequest({ body: {}, headers: new Headers() })).rejects.toBe(original)
  })

  test("strategy abort → throws the ORIGINAL caught error (legacy parity), having recorded the classified error", async () => {
    const { ctx, calls } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    const original = new Error("boom")
    const transport = makeTransport(async () => {
      throw original
    })
    const abortErr = { type: "bad_request", message: "aborted" } as unknown as ApiError
    const strategy: RetryStrategy = { name: "abort", canHandle: () => true, handle: async () => ({ kind: "abort", error: abortErr }) }
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport, strategies: [strategy] })

    await expect(driver.runRequest({ body: {}, headers: new Headers() })).rejects.toBe(original)
    expect(calls.setAttemptError).toHaveLength(1)
  })
})

describe("driver.runResponse — S5 chain + S6 render", () => {
  async function collect(it: AsyncIterable<ClientFrame>): Promise<Array<ClientFrame>> {
    const out: Array<ClientFrame> = []
    for await (const f of it) out.push(f)
    return out
  }

  test("identity (no rewrites): renders + yields every frame + samples upstream sseEvents", async () => {
    const { ctx, calls } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const frames: Array<UpstreamFrame> = [{ data: "1" }, { data: "2" }]

    const out = await collect(driver.runResponse(okStream(frames), env))
    expect(out.map((f) => f.data)).toEqual(["1", "2"])

    // P3.2b: the driver samples each upstream-original frame at the loop top (raw
    // verbatim, BEFORE render) — aliased onto ctx so a single setSseEvents call
    // exposes the growing array with every consumed frame.
    expect(calls.setSseEvents).toHaveLength(1)
    const sampled = calls.setSseEvents[0] as Array<{ type: string; raw: string }>
    expect(sampled.map((e) => ({ type: e.type, raw: e.raw }))).toEqual([
      { type: "message", raw: "1" },
      { type: "message", raw: "2" },
    ])
  })

  test("suppress drops a frame; emit replaces; chain order respected", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    // r1: suppress frames with data "drop"; r2: tag surviving frames
    const r1: ResponseRewrite = {
      name: "filter",
      order: 100,
      appliesTo: () => true,
      transform: (frame): FrameAction => (frame.data === "drop" ? { kind: "suppress" } : { kind: "emit", frames: [frame] }),
    }
    const r2: ResponseRewrite = {
      name: "tag",
      order: 200,
      appliesTo: () => true,
      transform: (frame): FrameAction => ({ kind: "emit", frames: [{ data: `${frame.data}!` }] }),
    }
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport: makeTransport(async () => okStream()),
      responseRewrites: [r2, r1],
    })
    const frames: Array<UpstreamFrame> = [{ data: "keep" }, { data: "drop" }, { data: "also" }]

    const out = await collect(driver.runResponse(okStream(frames), env))
    expect(out.map((f) => f.data)).toEqual(["keep!", "also!"])
  })

  test("buffer + flush: a rewrite accumulates then drains at stream end", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    interface BufState extends RewriteState {
      buf: Array<string>
    }
    const accumulate: ResponseRewrite = {
      name: "accumulate",
      order: 100,
      appliesTo: () => true,
      createState: (): BufState => ({ buf: [] }),
      transform: (frame, state): FrameAction => {
        ;(state as BufState).buf.push(frame.data ?? "")
        return { kind: "buffer" }
      },
      flush: (state): Array<UpstreamFrame> => [{ data: (state as BufState).buf.join(",") }],
    }
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport: makeTransport(async () => okStream()),
      responseRewrites: [accumulate],
    })
    const frames: Array<UpstreamFrame> = [{ data: "a" }, { data: "b" }, { data: "c" }]

    const out = await collect(driver.runResponse(okStream(frames), env))
    expect(out.map((f) => f.data)).toEqual(["a,b,c"])
  })

  test("flushed frames thread through subsequent rewrites", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    const buffer: ResponseRewrite = {
      name: "buffer-one",
      order: 100,
      appliesTo: () => true,
      createState: (): RewriteState => ({ held: undefined as string | undefined }),
      transform: (frame, state): FrameAction => {
        ;(state as { held?: string }).held = frame.data
        return { kind: "buffer" }
      },
      flush: (state): Array<UpstreamFrame> => [{ data: (state as { held?: string }).held ?? "" }],
    }
    const tagAfter: ResponseRewrite = {
      name: "tag-after",
      order: 200,
      appliesTo: () => true,
      transform: (frame): FrameAction => ({ kind: "emit", frames: [{ data: `[${frame.data}]` }] }),
    }
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport: makeTransport(async () => okStream()),
      responseRewrites: [buffer, tagAfter],
    })

    const out = await collect(driver.runResponse(okStream([{ data: "x" }]), env))
    // x is buffered by rewrite[0]; on flush its output threads rewrite[1] → "[x]"
    expect(out.map((f) => f.data)).toEqual(["[x]"])
  })

  test("flush on exception: a buffering rewrite drains in finally when upstream throws (H3 — exception-path parity)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    interface BufState extends RewriteState {
      buf: Array<string>
    }
    // Buffers every frame, flushes the joined accumulation — a stand-in for a
    // migrated buffering rewrite (decode / recover) holding tool_use fragments.
    const accumulate: ResponseRewrite = {
      name: "accumulate",
      order: 100,
      appliesTo: () => true,
      createState: (): BufState => ({ buf: [] }),
      transform: (frame, state): FrameAction => {
        ;(state as BufState).buf.push(frame.data ?? "")
        return { kind: "buffer" }
      },
      flush: (state): Array<UpstreamFrame> => [{ data: (state as BufState).buf.join(",") }],
    }
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport: makeTransport(async () => okStream()),
      responseRewrites: [accumulate],
    })

    // Upstream yields two frames, then throws (mid-stream transport blow-up).
    async function* throwAfter(items: Array<UpstreamFrame>): AsyncIterable<UpstreamFrame> {
      for (const it of items) yield it
      throw new Error("upstream blew up")
    }
    const upstream: UpstreamStream = { frames: throwAfter([{ data: "a" }, { data: "b" }]), headers: new Headers() }

    const collected: Array<ClientFrame> = []
    let caught: unknown
    try {
      for await (const f of driver.runResponse(upstream, env)) collected.push(f)
    } catch (error) {
      caught = error
    }

    // The exception still surfaces to the consumer (finally drains, then re-throws).
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("upstream blew up")
    // The buffered frames were flushed in `finally` BEFORE the error propagated —
    // without try/finally `flushChain` (post-loop) is unreachable on a throw and the
    // held frames are silently dropped (the H3 regression Phase 4 would introduce).
    expect(collected.map((f) => f.data)).toEqual(["a,b"])
  })

  // ── T1: skipRender (dry-run sees the S5-rewritten, PRE-render frames) ──

  test("skipRender:false (default) yields RENDERED frames; skipRender:true yields the PRE-render S5 frames", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    // A NON-identity render so the two modes are distinguishable (Anthropic render is
    // identity, hence Phase 1 didn't need skipRender; CC-via-responses / Responses render
    // is non-identity, where dry-run must observe the S5 frames BEFORE S6 render).
    const { codec } = makeCodec({ renderResponse: (frame) => ({ data: `R(${frame.data})` }), env })
    const tag: ResponseRewrite = {
      name: "tag",
      order: 100,
      appliesTo: () => true,
      transform: (frame): FrameAction => ({ kind: "emit", frames: [{ data: `S(${frame.data})` }] }),
    }
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport: makeTransport(async () => okStream()),
      responseRewrites: [tag],
    })
    const frames: Array<UpstreamFrame> = [{ data: "1" }, { data: "2" }]

    const rendered = await collect(driver.runResponse(okStream(frames), env))
    expect(rendered.map((f) => f.data)).toEqual(["R(S(1))", "R(S(2))"])

    const preRender = await collect(driver.runResponse(okStream(frames), env, { skipRender: true }))
    // S5 applied (tag), render skipped → the S5-rewritten frame verbatim.
    expect(preRender.map((f) => f.data)).toEqual(["S(1)", "S(2)"])
  })

  test("skipRender covers the flushChain path (stream-end buffered frames are also un-rendered)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ renderResponse: (frame) => ({ data: `R(${frame.data})` }), env })
    interface BufState extends RewriteState {
      buf: Array<string>
    }
    const accumulate: ResponseRewrite = {
      name: "accumulate",
      order: 100,
      appliesTo: () => true,
      createState: (): BufState => ({ buf: [] }),
      transform: (frame, state): FrameAction => {
        ;(state as BufState).buf.push(frame.data ?? "")
        return { kind: "buffer" }
      },
      flush: (state): Array<UpstreamFrame> => [{ data: (state as BufState).buf.join(",") }],
    }
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport: makeTransport(async () => okStream()),
      responseRewrites: [accumulate],
    })
    const frames: Array<UpstreamFrame> = [{ data: "a" }, { data: "b" }]

    // The only output frame comes from flushChain (everything was buffered). skipRender
    // MUST cover that yield point too (RFC §11 red line — else stream-end buffered frames
    // get rendered while loop-body frames don't, an inconsistent half-render).
    const rendered = await collect(driver.runResponse(okStream(frames), env))
    expect(rendered.map((f) => f.data)).toEqual(["R(a,b)"])

    const preRender = await collect(driver.runResponse(okStream(frames), env, { skipRender: true }))
    expect(preRender.map((f) => f.data)).toEqual(["a,b"])
  })

  // ── T2: per-rewrite frameActions sampling (onRewriteAction hook) ──

  test("onRewriteAction samples each rewrite's per-frame action (emit / suppress / buffer)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    // filter: suppress "drop"; buffer-til-stop: buffer everything except a "stop" frame,
    // at which it emits the joined accumulation (mirrors decode at content_block_stop).
    const filter: ResponseRewrite = {
      name: "filter",
      order: 100,
      appliesTo: () => true,
      transform: (frame): FrameAction => (frame.data === "drop" ? { kind: "suppress" } : { kind: "emit", frames: [frame] }),
    }
    const bufTilStop: ResponseRewrite = {
      name: "buf-til-stop",
      order: 200,
      appliesTo: () => true,
      createState: (): RewriteState => ({ buf: [] as Array<string> }),
      transform: (frame, state): FrameAction => {
        const buf = (state as { buf: Array<string> }).buf
        if (frame.data === "stop") return { kind: "emit", frames: [{ data: buf.join(",") }] }
        buf.push(frame.data ?? "")
        return { kind: "buffer" }
      },
    }
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport: makeTransport(async () => okStream()),
      responseRewrites: [filter, bufTilStop],
    })
    const frames: Array<UpstreamFrame> = [{ data: "keep" }, { data: "drop" }, { data: "stop" }]

    const sampled: Array<{ name: string; frameIndex: number; kind: string }> = []
    const out = await collect(
      driver.runResponse(okStream(frames), env, { onRewriteAction: (name, frameIndex, action) => sampled.push({ name, frameIndex, kind: action.kind }) }),
    )
    expect(out.map((f) => f.data)).toEqual(["keep"])

    // frame 0 "keep": filter emit → buf-til-stop buffer.
    // frame 1 "drop": filter suppress → buf-til-stop NOT reached (no surviving frame).
    // frame 2 "stop": filter emit → buf-til-stop emit (drains "keep,").
    expect(sampled).toEqual([
      { name: "filter", frameIndex: 0, kind: "emit" },
      { name: "buf-til-stop", frameIndex: 0, kind: "buffer" },
      { name: "filter", frameIndex: 1, kind: "suppress" },
      { name: "filter", frameIndex: 2, kind: "emit" },
      { name: "buf-til-stop", frameIndex: 2, kind: "emit" },
    ])
  })

  test("onRewriteAction is not invoked when omitted (zero production overhead)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    const r: ResponseRewrite = { name: "id", order: 100, appliesTo: () => true, transform: (f): FrameAction => ({ kind: "emit", frames: [f] }) }
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport: makeTransport(async () => okStream()),
      responseRewrites: [r],
    })
    // No opts → no hook; just assert it runs cleanly (the hook ref is undefined, never called).
    const out = await collect(driver.runResponse(okStream([{ data: "x" }]), env))
    expect(out.map((f) => f.data)).toEqual(["x"])
  })
})

describe("driver.runResponseSink — owns-sink wrapping shim (B1)", () => {
  async function* throwingStream(items: Array<UpstreamFrame>): AsyncIterable<UpstreamFrame> {
    for (const i of items) yield i
    throw new Error("upstream blew up")
  }

  test("equivalence: sink frame sequence == generator yield sequence; outcome=complete+headers", async () => {
    const { ctx } = makeCtx()
    const { codec } = makeCodec({ env: makeEnv(ctx) })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const frames: Array<UpstreamFrame> = [{ data: "1" }, { data: "2" }, { data: "3" }]

    // generator yield sequence
    const genOut: Array<ClientFrame> = []
    for await (const f of driver.runResponse(okStream(frames), makeEnv(ctx))) genOut.push(f)

    // owns-sink sequence — must equal the generator's, by construction (wrapping shim)
    const { sink, frames: sunk } = makeArraySink()
    const headers = new Headers({ "x-up": "1" })
    const outcome = await driver.runResponseSink({ frames: gen(frames), headers }, makeEnv(ctx), sink)

    expect(sunk).toEqual(genOut)
    expect(outcome).toEqual({ kind: "complete", headers })
  })

  test("drops the [DONE] transport sentinel — never written to a sink (B2 cut-over red line)", async () => {
    const { ctx } = makeCtx()
    const { codec } = makeCodec({ env: makeEnv(ctx) })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const { sink, frames } = makeArraySink()

    // The generator YIELDS the [DONE] frame (identity render); the sink must NOT receive it.
    const outcome = await driver.runResponseSink(okStream([{ data: "x" }, { data: "[DONE]" }, { data: "y" }]), makeEnv(ctx), sink)

    expect(frames).toEqual([{ data: "x" }, { data: "y" }])
    expect(outcome.kind).toBe("complete")
  })

  test("rejecting sink (client disconnect mid-write) → non-complete outcome, never complete", async () => {
    const { ctx } = makeCtx()
    const { codec } = makeCodec({ env: makeEnv(ctx) })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const { sink, frames: sunk } = makeArraySink({ rejectAtFrame: 1 })

    const outcome = await driver.runResponseSink(okStream([{ data: "1" }, { data: "2" }, { data: "3" }]), makeEnv(ctx), sink)

    // The disconnect must NOT be swallowed into `complete`.
    expect(outcome.kind).not.toBe("complete")
    expect(outcome.kind).toBe("stream-error")
    // Frame 0 was written before the reject at frame 1.
    expect(sunk).toEqual([{ data: "1" }])
  })

  test("sink.close() runs on BOTH normal completion and an upstream throw", async () => {
    const { ctx } = makeCtx()
    const { codec } = makeCodec({ env: makeEnv(ctx) })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })

    let closedOk = 0
    const okArr = makeArraySink()
    const okSink: ClientSink = { write: okArr.sink.write, close: () => void closedOk++ }
    expect((await driver.runResponseSink(okStream([{ data: "x" }]), makeEnv(ctx), okSink)).kind).toBe("complete")
    expect(closedOk).toBe(1)

    let closedErr = 0
    const errSink: ClientSink = { write: () => Promise.resolve(), close: () => void closedErr++ }
    const outcome = await driver.runResponseSink({ frames: throwingStream([{ data: "a" }]), headers: new Headers() }, makeEnv(ctx), errSink)
    expect(outcome.kind).toBe("stream-error")
    expect(closedErr).toBe(1)
  })

  test("a thrown StreamClientAbortError → settled-abort (not stream-error)", async () => {
    const { ctx } = makeCtx()
    const { codec } = makeCodec({ env: makeEnv(ctx) })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })

    async function* abortingStream(): AsyncIterable<UpstreamFrame> {
      yield { data: "1" }
      throw new StreamClientAbortError()
    }
    const { sink, frames } = makeArraySink()
    const outcome = await driver.runResponseSink({ frames: abortingStream(), headers: new Headers() }, makeEnv(ctx), sink)

    // A client-abort settles distinctly — the handler writes ZERO further bytes (B0-d).
    expect(outcome.kind).toBe("settled-abort")
    // The frame before the abort was still written.
    expect(frames).toEqual([{ data: "1" }])
  })

  test("stream-error carries the RAW thrown error (richest-data-flow), not a {type,message} summary", async () => {
    const { ctx } = makeCtx()
    const { codec } = makeCodec({ env: makeEnv(ctx) })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })

    const raw = new Error("upstream blew up")
    async function* throwRaw(): AsyncIterable<UpstreamFrame> {
      yield { data: "1" }
      throw raw
    }
    const { sink } = makeArraySink()
    const outcome = await driver.runResponseSink({ frames: throwRaw(), headers: new Headers() }, makeEnv(ctx), sink)
    expect(outcome.kind).toBe("stream-error")
    // The handler is the consumer that classifies/formats/logs — it gets the SAME error object.
    if (outcome.kind === "stream-error") expect(outcome.error).toBe(raw)
  })

  test("sink.close() runs on the abort + write-reject exits too (full leak matrix)", async () => {
    const { ctx } = makeCtx()
    const { codec } = makeCodec({ env: makeEnv(ctx) })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })

    // Exit 3 — client abort.
    let closedAbort = 0
    async function* abortStream(): AsyncIterable<UpstreamFrame> {
      yield { data: "1" }
      throw new StreamClientAbortError()
    }
    const abortSink: ClientSink = { write: () => Promise.resolve(), close: () => void closedAbort++ }
    expect((await driver.runResponseSink({ frames: abortStream(), headers: new Headers() }, makeEnv(ctx), abortSink)).kind).toBe("settled-abort")
    expect(closedAbort).toBe(1)

    // Exit 4 — sink.write reject (client disconnect mid-write).
    let closedReject = 0
    const rejectArr = makeArraySink({ rejectAtFrame: 0 })
    const rejectSink: ClientSink = { write: rejectArr.sink.write, close: () => void closedReject++ }
    const outcome = await driver.runResponseSink(okStream([{ data: "1" }]), makeEnv(ctx), rejectSink)
    expect(outcome.kind).toBe("stream-error") // a plain reject is NOT classified client-abort
    expect(closedReject).toBe(1)
  })
})

describe("driver.runResponseNonStreaming", () => {
  test("delegates to codec.renderResponseNonStreaming with upstream.nonStream", () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec, spy } = makeCodec({ env })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })

    const rendered = driver.runResponseNonStreaming(okStream([], { raw: "body" }), env)
    expect(spy.renderResponseNonStreaming).toBe(1)
    expect(rendered).toEqual({ rendered: { raw: "body" } })
  })
})

// ── C0 shared-driver contract (RFC §11.1 / §11.2) ──────────────────────────

describe("driver C0 — post-retry env + post-gate meta channel", () => {
  test("runRequest returns the POST-retry env (C0-①): a strategy that mutates body is visible to the caller", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx, { v: 0 })
    const { codec } = makeCodec({ env })
    let attempts = 0
    const transport = makeTransport(async () => {
      attempts++
      if (attempts === 1) throw new Error("boom")
      return okStream()
    })
    // The Anthropic pump reads env.body (tools) post-retry; a pre-retry env would
    // surface the un-mutated body. Mirror that with a body-mutating strategy.
    const strategy: RetryStrategy = {
      name: "mutate-body",
      canHandle: () => true,
      handle: async (_e, e) => ({ kind: "retry", env: e.with({ body: { v: 42 } }) }),
    }
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport, strategies: [strategy] })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.env.body as { v: number }).v).toBe(42) // pre-retry env would be 0
  })

  test("onMeta fires post-gate with the accepted retry's meta; onResolved receives the same meta (C0-②)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    let attempts = 0
    const transport = makeTransport(async () => {
      attempts++
      if (attempts === 1) throw new Error("boom")
      return okStream()
    })
    const metaSeen: Array<Record<string, unknown>> = []
    let resolvedMeta: Record<string, unknown> | undefined
    let resolvedCalled = 0
    const strategy: RetryStrategy = {
      name: "meta-retry",
      canHandle: () => true,
      handle: async (_e, e) => ({ kind: "retry", env: e, meta: { probedBetas: ["beta-x"] } }),
      // A meta-querying spy (NOT the no-arg `()=>count++` that let CC miss the contract — RFC §12.3).
      onResolved: (_env, meta) => {
        resolvedCalled++
        resolvedMeta = meta
      },
    }
    const onMeta = (meta: Record<string, unknown>): void => {
      metaSeen.push(meta)
    }
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport, strategies: [strategy], onMeta })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })
    expect(result.ok).toBe(true)
    expect(metaSeen).toEqual([{ probedBetas: ["beta-x"] }])
    expect(resolvedCalled).toBe(1)
    expect(resolvedMeta).toEqual({ probedBetas: ["beta-x"] })
  })

  test("a budget-rejected retry's meta never reaches onMeta or onResolved (C0-②, no phantom pipeline-info)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    const transport = makeTransport(async () => {
      throw new Error("boom") // always fails → forces budget exhaustion
    })
    const metaSeen: Array<Record<string, unknown>> = []
    let resolvedCalled = 0
    let n = 0
    const strategy: RetryStrategy = {
      name: "meta-retry",
      canHandle: () => true,
      handle: async (_e, e) => ({ kind: "retry", env: e, meta: { truncated: ++n } }),
      onResolved: () => {
        resolvedCalled++
      },
    }
    const onMeta = (meta: Record<string, unknown>): void => {
      metaSeen.push(meta)
    }
    // maxRetries:1 → attempt1 fail → retry#1 meta{1} ACCEPTED (0>=1 F) → attempt2 fail
    //   → retry#2 meta{2} REJECTED by budget gate (1>=1 T) → throw, meta{2} discarded.
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport, strategies: [strategy], onMeta, maxRetries: 1 })

    await expect(driver.runRequest({ body: {}, headers: new Headers() })).rejects.toThrow("boom")
    expect(metaSeen).toEqual([{ truncated: 1 }]) // only the accepted retry, NOT {truncated:2}
    expect(resolvedCalled).toBe(0) // never succeeded
  })

  test("onResolved without a meta sink still fires (env-only); no onMeta is fine", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    let attempts = 0
    const transport = makeTransport(async () => {
      attempts++
      if (attempts === 1) throw new Error("boom")
      return okStream()
    })
    let resolvedCalled = 0
    const strategy: RetryStrategy = {
      name: "no-meta-retry",
      canHandle: () => true,
      handle: async (_e, e) => ({ kind: "retry", env: e }), // no meta
      onResolved: () => {
        resolvedCalled++
      },
    }
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport, strategies: [strategy] }) // no onMeta

    const result = await driver.runRequest({ body: {}, headers: new Headers() })
    expect(result.ok).toBe(true)
    expect(resolvedCalled).toBe(1)
  })
})

// ── C0 — CC truncateResult phantom guard (RFC §12.3) ───────────────────────
// The phantom bug: the pre-gate adapter onMeta fired CC's `recordFeature("truncated")`
// even for a budget-rejected truncate retry. Post-gate the driver only emits the
// accepted retry's meta, so a budget-exhausting truncate records NO phantom feature.

describe("driver C0 — CC truncateResult phantom guard (RFC §12.3)", () => {
  // A CC-handler-style onMeta sink: records "truncated" iff a truncateResult meta
  // arrives (mirrors handler-v4's onMeta).
  const ccOnMeta =
    (features: Array<string>) =>
    (meta: Record<string, unknown>): void => {
      if (meta.truncateResult) features.push("truncated")
    }
  // A legacy auto-truncate-shaped strategy: handles any error by retrying with a
  // truncateResult meta (we don't exercise the real tokenizer here — that has its
  // own unit tests; this asserts the adapter→driver→onMeta budget-gating).
  const truncateLegacy = (): LegacyRetryStrategy<{ v: number }> => ({
    name: "auto-truncate",
    canHandle: () => true,
    handle: (_e, p) => Promise.resolve({ action: "retry", payload: p, meta: { truncateResult: { wasTruncated: true } } }),
  })

  test("a successful truncate retry records the truncated feature (normal path intact)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    let attempts = 0
    const transport = makeTransport(async () => {
      attempts++
      if (attempts === 1) throw new Error("limit")
      return okStream()
    })
    const features: Array<string> = []
    const strategies = [adaptLegacyStrategy(truncateLegacy(), { attemptRef: { value: 0 }, originalPayload: { v: 0 }, model: undefined, maxRetries: 1 })]
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport,
      strategies,
      onMeta: ccOnMeta(features),
      maxRetries: 1,
    })

    const result = await driver.runRequest({ body: { v: 0 }, headers: new Headers() })
    expect(result.ok).toBe(true)
    expect(features).toEqual(["truncated"])
  })

  test("a truncate retry that immediately exceeds maxRetries records NO phantom truncated feature", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    const transport = makeTransport(async () => {
      throw new Error("limit") // always fails
    })
    const features: Array<string> = []
    const strategies = [adaptLegacyStrategy(truncateLegacy(), { attemptRef: { value: 0 }, originalPayload: { v: 0 }, model: undefined, maxRetries: 0 })]
    // maxRetries:0 → the first truncate retry is rejected by the budget gate
    // (0>=0) → throw before its meta emits. The old pre-gate adapter onMeta would
    // have fired a phantom "truncated" here.
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport,
      strategies,
      onMeta: ccOnMeta(features),
      maxRetries: 0,
    })

    await expect(driver.runRequest({ body: { v: 0 }, headers: new Headers() })).rejects.toThrow("limit")
    expect(features).toEqual([])
  })
})
