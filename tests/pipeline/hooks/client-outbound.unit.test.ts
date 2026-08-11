/**
 * Phase 6 (RFC 2026-07-14 §5) — the `client.outbound` mount point: per rendered client frame at S6
 * render→yield, before the sink write. Covers render-produced frames (the §9 coverage gap for
 * sink-layer synthetic/heartbeat frames is documented on the type). Mirrors driver-provenance's
 * runResponse driving.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

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

describe("hooks — client.outbound mount point (Phase 6)", () => {
  test("rewrites each rendered client frame before the sink write", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({ client: { outbound: (frame) => ({ ...frame, data: `OUT(${frame.data})` }) } })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const frames: Array<UpstreamFrame> = [{ data: "a" }, { data: "b" }]

    const out = await collect(driver.runResponse(okStream(frames), env))

    expect(out.map((f) => f.data)).toEqual(["OUT(a)", "OUT(b)"])
  })

  test("returning undefined drops the client frame from the forwarded output", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({ client: { outbound: (frame) => (frame.data === "drop" ? undefined : frame) } })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const frames: Array<UpstreamFrame> = [{ data: "a" }, { data: "drop" }, { data: "b" }]

    const out = await collect(driver.runResponse(okStream(frames), env))

    expect(out.map((f) => f.data)).toEqual(["a", "b"])
  })

  test("no client.outbound mounted → frames pass through unchanged", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    setUpstreamHookForTests({ client: { inbound: (e) => e } })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })
    const frames: Array<UpstreamFrame> = [{ data: "a" }, { data: "b" }]

    const out = await collect(driver.runResponse(okStream(frames), env))

    expect(out.map((f) => f.data)).toEqual(["a", "b"])
  })
})
