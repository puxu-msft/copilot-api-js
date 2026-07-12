/**
 * Task 1.3 + 2.2 (docs/plan/2026-07-12-upstream-hook-middleware, plan-1 §Task 1.3 +
 * plan-2 §Task 2.2) — the `rewriteUpstreamFrame` per-frame mount point AND the
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

beforeEach(() => {
  resetUpstreamHook()
})
afterEach(() => {
  resetUpstreamHook()
})

describe("hooks — rewriteUpstreamFrame mount point (Task 1.3)", () => {
  test("H2: forwarded frames are rewritten, but ctx.sseEvents (upstream-original track) keeps the PRE-hook frame", async () => {
    const { ctx, calls } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({
      rewriteUpstreamFrame: (frame) => ({ ...frame, data: `REWRITTEN(${frame.data})` }),
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
      rewriteUpstreamFrame: (frame) => (frame.data === "drop" ? undefined : frame),
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
      rewriteUpstreamFrame: (frame) => (frame.data === "drop" ? undefined : frame),
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

  test("no rewriteUpstreamFrame mounted (hook has only other mount points) → frames pass through unchanged", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({ onRequest: (e) => e })
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
