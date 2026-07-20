/**
 * Task 1.1-1.2 (docs/plan/2026-07-12-upstream-hook-middleware/plan-1-driver-hookpoints.md)
 * — `upstream.outbound` (one-shot, retry-loop-external) + `exchange` (wraps `transport.send`)
 * hook mount points. Byte-equivalence when unconfigured is the golden test's job
 * (driver-passthrough-golden.it.test.ts); this file exercises the CONFIGURED behavior +
 * the invariants the plan calls out by name (H1 one-shot, H2 upstream-track purity —
 * the latter lands with Task 1.3 in driver-provenance.unit.test.ts).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { UpstreamStream } from "~/lib/pipeline/types"

import { HTTPError } from "~/lib/error"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import {
  //
  resetUpstreamHook,
  setUpstreamHookForTests,
} from "~/lib/pipeline/hooks/loader"

import {
  //
  BASE,
  makeCodec,
  makeCtx,
  makeEnv,
  makeTransport,
  okStream,
} from "./driver-test-helpers"

beforeEach(() => {
  resetUpstreamHook()
})
afterEach(() => {
  resetUpstreamHook()
})

describe("hooks — upstream.outbound mount point (Task 1.1)", () => {
  test("upstream.outbound's return value is what reaches transport.send (env rewrite is observed by the exchange)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx, { tag: "original" })
    const { codec } = makeCodec({ env })
    let sentBody: unknown
    const transport = makeTransport(async (_wire, e) => ((sentBody = e.body), okStream()))
    setUpstreamHookForTests({
      upstream: { outbound: (e) => e.with({ body: { tag: "rewritten-by-hook" } }) },
    })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })

    expect(result.ok).toBe(true)
    expect(sentBody).toEqual({ tag: "rewritten-by-hook" })
  })

  test("upstream.outbound returning undefined falls back to the pre-hook rewritten env (no-op)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx, { tag: "original" })
    const { codec } = makeCodec({ env })
    let sentBody: unknown
    const transport = makeTransport(async (_wire, e) => ((sentBody = e.body), okStream()))
    setUpstreamHookForTests({ upstream: { outbound: () => undefined } })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    await driver.runRequest({ body: {}, headers: new Headers() })

    expect(sentBody).toEqual({ tag: "original" })
  })

  test("H1: upstream.outbound is invoked exactly ONCE, even when a strategy retries several attempts", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx, { tag: "original" })
    const { codec } = makeCodec({ env })
    let attempts = 0
    const transport = makeTransport(async () => {
      attempts++
      if (attempts < 3) throw new Error("boom")
      return okStream()
    })
    let onRequestCalls = 0
    setUpstreamHookForTests({
      upstream: {
        outbound: (e) => {
          onRequestCalls++
          return e
        },
      },
    })
    const strategy = { name: "retry-always", canHandle: () => true, handle: async (_err: unknown, e: RequestEnvelope) => ({ kind: "retry" as const, env: e }) }
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport, strategies: [strategy] })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })

    expect(result.ok).toBe(true)
    expect(attempts).toBe(3)
    expect(onRequestCalls).toBe(1)
  })

  test("no upstream.outbound mounted (hook has only other mount points) → env passes through unchanged", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx, { tag: "original" })
    const { codec } = makeCodec({ env })
    let sentBody: unknown
    const transport = makeTransport(async (_wire, e) => ((sentBody = e.body), okStream()))
    setUpstreamHookForTests({ exchange: async (_wire, _e, next) => next() })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    await driver.runRequest({ body: {}, headers: new Headers() })

    expect(sentBody).toEqual({ tag: "original" })
  })
})

describe("hooks — exchange mount point (Task 1.2)", () => {
  test("exchange short-circuits (never calls next) → transport.send is NEVER invoked, hook's stream is used", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    let sendCalled = false
    const transport = makeTransport(async () => ((sendCalled = true), okStream()))
    const mockUpstream: UpstreamStream = okStream([{ data: "mocked" }])
    setUpstreamHookForTests({ exchange: async () => mockUpstream })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })

    expect(result.ok).toBe(true)
    expect(sendCalled).toBe(false)
    if (result.ok) expect(result.upstream).toBe(mockUpstream)
  })

  test("exchange calls next() and wraps the result → transport.send IS invoked, wrapped stream flows through", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    let sendCalled = false
    const realUpstream = okStream([{ data: "real" }])
    const transport = makeTransport(async () => ((sendCalled = true), realUpstream))
    let nextCalled = false
    setUpstreamHookForTests({
      exchange: async (_wire, _e, next) => {
        const upstream = await next()
        nextCalled = true
        return upstream
      },
    })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })

    expect(result.ok).toBe(true)
    expect(sendCalled).toBe(true)
    expect(nextCalled).toBe(true)
    if (result.ok) expect(result.upstream).toBe(realUpstream)
  })

  test("exchange throws an HTTPError → driver's catch handles it exactly like a transport.send throw (reactive-retry branch)", async () => {
    const { ctx, calls } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    let attempts = 0
    setUpstreamHookForTests({
      exchange: async () => {
        attempts++
        if (attempts === 1) throw new HTTPError("bad request", 400, "boom-body")
        return okStream()
      },
    })
    const transport = makeTransport(async () => okStream())
    let handled = 0
    const strategy = {
      name: "handles-400",
      canHandle: () => true,
      handle: async (_err: unknown, e: RequestEnvelope) => (handled++, { kind: "retry" as const, env: e }),
    }
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport, strategies: [strategy] })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })

    expect(result.ok).toBe(true)
    expect(attempts).toBe(2)
    expect(handled).toBe(1)
    expect(calls.setAttemptError).toHaveLength(1)
  })

  test("unconfigured exchange → deps.transport.send is called directly (golden-equivalent path)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    let sendCalled = false
    const transport = makeTransport(async () => ((sendCalled = true), okStream()))
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    await driver.runRequest({ body: {}, headers: new Headers() })

    expect(sendCalled).toBe(true)
  })
})
