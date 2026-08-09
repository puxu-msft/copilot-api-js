/**
 * Task 1.3 + 2.2 (docs/plan/2026-07-12-upstream-hook-middleware, plan-1 §Task 1.3 +
 * plan-2 §Task 2.2) — the `upstream.inbound` per-frame mount point AND the
 * mock/replay `HOOK_ORIGIN` upstream-track synthetic marker. Landed together: both touch
 * the exact same `runResponse` loop body (driver.ts ~line 440-456) and share the same
 *承重不变量 — the upstream-original track (`ctx.sseEvents`, sampled via `upstreamSse.push`
 * BEFORE the hook runs) must NEVER reflect hook-produced content:
 *   - a rewrite hook may only touch the FORWARDED frames, never the upstream-original ones
 *     (H2 — the upstream track always keeps the pre-hook real frame).
 *   - a mock/replay stream tags EVERY frame it contributes to the upstream-original track
 *     with `synthetic: "hook-mock" | "hook-replay"` (richest-data-flow: hook-produced
 *     traffic must stay distinguishable from real upstream bytes).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ResponseRewrite } from "~/lib/pipeline/rewrite-registry"
import type {
  //
  ClientFrame,
  UpstreamFrame,
} from "~/lib/pipeline/types"

import { makeSseSink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import {
  //
  resetUpstreamHook,
  setUpstreamHookForTests,
} from "~/lib/pipeline/hooks/loader"
import { tagStream } from "~/lib/pipeline/hooks/origin"

import {
  //
  BASE,
  makeCodec,
  makeCtx,
  makeEnv,
  makeTransport,
  okStream,
} from "./driver-test-helpers"

async function collect(it: AsyncIterable<ClientFrame>): Promise<Array<ClientFrame>> {
  const out: Array<ClientFrame> = []
  for await (const f of it) out.push(f)
  return out
}

/** Minimal `SSEStreamingApi` stub — only `writeSSE` is exercised by `makeSseSink` (mirrors
 * `tests/pipeline/client-sink.unit.test.ts`'s `mockStream` helper). */
function mockStream(): Parameters<typeof makeSseSink>[0] {
  return { write: (_msg: unknown) => Promise.resolve() } as unknown as Parameters<typeof makeSseSink>[0]
}

beforeEach(() => {
  resetUpstreamHook()
})
afterEach(() => {
  resetUpstreamHook()
})

describe("hooks — upstream.inbound mount point (Task 1.3)", () => {
  test("H2: forwarded frames are rewritten, but ctx.sseEvents (upstream-original track) keeps the PRE-hook frame", async () => {
    const { ctx, calls } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({
      upstream: { inbound: (frame) => ({ ...frame, data: `REWRITTEN(${frame.data})` }) },
    })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const frames: Array<UpstreamFrame> = [{ data: "a" }, { data: "b" }]

    const out = await collect(driver.runResponse(okStream(frames), env))

    expect(out.map((f) => f.data)).toEqual(["REWRITTEN(a)", "REWRITTEN(b)"])
    expect(calls.setSseEvents).toHaveLength(1)
    const sampled = calls.setSseEvents[0] as Array<{ raw: string }>
    expect(sampled.map((e) => e.raw)).toEqual(["a", "b"])
  })

  test("a hook returning undefined drops the frame from forwarded output", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({
      upstream: { inbound: (frame) => (frame.data === "drop" ? undefined : frame) },
    })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const frames: Array<UpstreamFrame> = [{ data: "a" }, { data: "drop" }, { data: "b" }]

    const out = await collect(driver.runResponse(okStream(frames), env))

    expect(out.map((f) => f.data)).toEqual(["a", "b"])
  })

  test("LOW-1 guard: dropping a frame still advances frameIndex (no `continue` skip)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({
      upstream: { inbound: (frame) => (frame.data === "drop" ? undefined : frame) },
    })
    // A single identity rewrite so `onRewriteAction` fires per SURVIVING frame — its
    // `frameIndex` argument is the raw-upstream-frame ordinal (advanced once per loop
    // iteration regardless of whether the hook dropped that iteration's frame).
    const identity: ResponseRewrite = { name: "id", order: 100, appliesTo: () => true, transform: (f) => ({ kind: "emit", frames: [f] }) }
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport: makeTransport(async () => okStream()),
      responseRewrites: [identity],
    })
    const frames: Array<UpstreamFrame> = [{ data: "a" }, { data: "drop" }, { data: "b" }]
    const seenFrameIndexes: Array<number> = []

    await collect(driver.runResponse(okStream(frames), env, { onRewriteAction: (_name, frameIndex) => seenFrameIndexes.push(frameIndex) }))

    // frame[0]="a" (kept, sampled at ordinal 0) → frame[1]="drop" (hook drops it, chain
    // never runs, no sample — but frameIndex STILL advances 1→2) → frame[2]="b" (kept,
    // sampled at ordinal 2, NOT 1). A `continue`-based drop would have produced [0, 1].
    expect(seenFrameIndexes).toEqual([0, 2])
  })

  test("no upstream.inbound mounted (hook has only other mount points) → frames pass through unchanged", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({ upstream: { outbound: (e) => e } })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const frames: Array<UpstreamFrame> = [{ data: "a" }, { data: "b" }]

    const out = await collect(driver.runResponse(okStream(frames), env))

    expect(out.map((f) => f.data)).toEqual(["a", "b"])
  })
})

describe("hooks — HOOK_ORIGIN upstream-track provenance marking (Task 2.2)", () => {
  test("a stream tagged hook-mock marks every upstream-original sseEvents frame synthetic:'hook-mock'", async () => {
    const { ctx, calls } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const tagged = tagStream(okStream([{ data: "a" }, { data: "b" }]), "hook-mock")

    await collect(driver.runResponse(tagged, env))

    expect(calls.setSseEvents).toHaveLength(1)
    const sampled = calls.setSseEvents[0] as Array<{ synthetic?: string }>
    expect(sampled.map((e) => e.synthetic)).toEqual(["hook-mock", "hook-mock"])
  })

  test("a stream tagged hook-replay marks every upstream-original sseEvents frame synthetic:'hook-replay'", async () => {
    const { ctx, calls } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const tagged = tagStream(okStream([{ data: "a" }]), "hook-replay")

    await collect(driver.runResponse(tagged, env))

    const sampled = calls.setSseEvents[0] as Array<{ synthetic?: string }>
    expect(sampled.map((e) => e.synthetic)).toEqual(["hook-replay"])
  })

  test("an UNTAGGED (real) stream's sseEvents carry no synthetic marker (golden-equivalent)", async () => {
    const { ctx, calls } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })

    await collect(driver.runResponse(okStream([{ data: "a" }, { data: "b" }]), env))

    const sampled = calls.setSseEvents[0] as Array<{ synthetic?: string }>
    expect(sampled.every((e) => e.synthetic === undefined)).toBe(true)
  })

  test("origin is read ONCE outside the frame loop (constant per stream) — a mid-stream mutation of the tag is not observed", async () => {
    const { ctx, calls } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const tagged = tagStream(okStream([{ data: "a" }, { data: "b" }, { data: "c" }]), "hook-mock")

    await collect(driver.runResponse(tagged, env))

    const sampled = calls.setSseEvents[0] as Array<{ synthetic?: string }>
    expect(sampled).toHaveLength(3)
    expect(sampled.every((e) => e.synthetic === "hook-mock")).toBe(true)
  })
})

describe("hooks — upstream.inbound forwarded-track hook-rewrite marking (Task 2.3)", () => {
  test("PASSTHROUGH leg (identity codec.renderResponse, e.g. Anthropic/CC direct): a rewritten frame is marked synthetic:'hook-rewrite' in the forwarded track; the upstream-original track stays pre-hook pure", async () => {
    const { ctx, calls } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env }) // default renderResponse is identity (returns `frame` verbatim)
    setUpstreamHookForTests({
      upstream: { inbound: (frame) => ({ ...frame, data: `REWRITTEN(${frame.data})` }) },
    })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const forwarded: Array<{ raw: string; synthetic?: string }> = []
    const sink = makeSseSink(mockStream(), { onForwarded: (r) => forwarded.push({ raw: r.raw, ...(r.synthetic ? { synthetic: r.synthetic } : {}) }) })

    const outcome = await driver.runResponseSink(okStream([{ data: "a" }, { data: "b" }]), env, sink)

    expect(outcome.kind).toBe("complete")
    expect(forwarded).toEqual([
      { raw: "REWRITTEN(a)", synthetic: "hook-rewrite" },
      { raw: "REWRITTEN(b)", synthetic: "hook-rewrite" },
    ])
    // Regression (Task 1.3/2.2 invariant): the upstream-original track is UNAFFECTED by this
    // forwarded-side tagging — it still records the pre-hook real frames, unmarked.
    const upstreamSampled = calls.setSseEvents[0] as Array<{ raw: string; synthetic?: string }>
    expect(upstreamSampled.map((e) => ({ raw: e.raw, synthetic: e.synthetic }))).toEqual([
      { raw: "a", synthetic: undefined },
      { raw: "b", synthetic: undefined },
    ])
  })

  test("a no-op rewrite hook (returns the SAME frame reference) is NOT marked hook-rewrite", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({ upstream: { inbound: (frame) => frame } })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const forwarded: Array<{ synthetic?: string }> = []
    const sink = makeSseSink(mockStream(), { onForwarded: (r) => forwarded.push({ ...(r.synthetic ? { synthetic: r.synthetic } : {}) }) })

    await driver.runResponseSink(okStream([{ data: "a" }]), env, sink)

    expect(forwarded).toEqual([{}])
  })

  test("a handler onRenderedFrame that SPREADS the input frame (`{...frame, data}`, e.g. chat-completions tool-name restore) preserves the hook-rewrite tag", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({ upstream: { inbound: (frame) => ({ ...frame, data: `REWRITTEN(${frame.data})` }) } })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const forwarded: Array<{ raw: string; synthetic?: string }> = []
    const sink = makeSseSink(mockStream(), { onForwarded: (r) => forwarded.push({ raw: r.raw, ...(r.synthetic ? { synthetic: r.synthetic } : {}) }) })
    const onRenderedFrame = (frame: ClientFrame): ClientFrame => ({ ...frame, data: `RESTORED(${frame.data})` })

    await driver.runResponseSink(okStream([{ data: "a" }]), env, sink, { onRenderedFrame })

    expect(forwarded).toEqual([{ raw: "RESTORED(REWRITTEN(a))", synthetic: "hook-rewrite" }])
  })

  test("KNOWN GAP — a TRANSLATE-leg codec.renderResponse (constructs a brand-new frame, e.g. Gemini/CC-via-Responses stream translators) loses the hook-rewrite tag; content still comes through", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env, renderResponse: (frame) => ({ data: `TRANSLATED(${frame.data})` }) })
    setUpstreamHookForTests({ upstream: { inbound: (frame) => ({ ...frame, data: `REWRITTEN(${frame.data})` }) } })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const forwarded: Array<{ raw: string; synthetic?: string }> = []
    const sink = makeSseSink(mockStream(), { onForwarded: (r) => forwarded.push({ raw: r.raw, ...(r.synthetic ? { synthetic: r.synthetic } : {}) }) })

    await driver.runResponseSink(okStream([{ data: "a" }]), env, sink)

    // Content is faithfully rewritten-then-translated; the tag is lost because the translate
    // leg builds a NEW frame object it never spread `frame` into (docs/spec/2026-07-12-upstream-
    // hook-middleware.md §3.4/§8 — genuinely ill-defined per-frame boundary, not a bug).
    expect(forwarded).toEqual([{ raw: "TRANSLATED(REWRITTEN(a))" }])
  })

  test("KNOWN GAP — a handler onRenderedFrame that reconstructs a FRESH literal without spreading (mirrors Responses' restoreAndAccumulate) loses the hook-rewrite tag even on an identity-render leg", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env }) // identity renderResponse (passthrough leg)
    setUpstreamHookForTests({ upstream: { inbound: (frame) => ({ ...frame, data: `REWRITTEN(${frame.data})` }) } })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const forwarded: Array<{ raw: string; synthetic?: string }> = []
    const sink = makeSseSink(mockStream(), { onForwarded: (r) => forwarded.push({ raw: r.raw, ...(r.synthetic ? { synthetic: r.synthetic } : {}) }) })
    const onRenderedFrame = (frame: ClientFrame): ClientFrame => ({ data: `RESTORED(${frame.data})` }) // fresh literal, no `...frame`

    await driver.runResponseSink(okStream([{ data: "a" }]), env, sink, { onRenderedFrame })

    expect(forwarded).toEqual([{ raw: "RESTORED(REWRITTEN(a))" }])
  })
})
