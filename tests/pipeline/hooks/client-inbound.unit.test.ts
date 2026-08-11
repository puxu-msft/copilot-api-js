/**
 * Phase 4 (RFC 2026-07-14-symmetric-four-point-hooks §3/§3.5) — the `client.inbound` mount point.
 *
 * `client.inbound` is a ONE-SHOT client-NATIVE request rewrite the driver runs at S1a→S1b (after
 * `codec.parse`, before `translateInbound`/route), the only stage where every format's body is
 * client-native. These tests exercise the DRIVER WIRING + the defensive-body-snapshot mechanism
 * directly — NOT `clientRequest` history as an oracle (real codecs already structuredClone the
 * history snapshot, so it is blind to the driver's snapshot; review HIGH-2 / §3.5 decision 4).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

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

describe("hooks — client.inbound mount point (Phase 4)", () => {
  test("the hook receives a DEFENSIVE body clone, not the parse env's own body (reference-independent — §3.5 snapshot)", async () => {
    const originalBody = {
      messages: [
        { role: "system", content: "boilerplate" },
        { role: "user", content: "hi" },
      ],
    }
    const { ctx } = makeCtx()
    const env = makeEnv(ctx, originalBody)
    const { codec } = makeCodec({ env })
    let seenBody: unknown
    setUpstreamHookForTests({ client: { inbound: (e) => ((seenBody = e.body), undefined) } })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })

    await driver.runRequest({ body: {}, headers: new Headers() })

    // The hook's env.body is a structuredClone, NOT the same object the codec's parse produced —
    // deleting the driver's `snapshotBody(...)` would make this assertion fail (proves it承重).
    expect(seenBody).not.toBe(originalBody)
    expect(seenBody).toEqual(originalBody)
  })

  test("in-place mutation + `undefined` return is DISCARDED — downstream sees the original parsed body", async () => {
    const originalBody = {
      messages: [
        { role: "system", content: "boilerplate" },
        { role: "user", content: "hi" },
      ],
    }
    const { ctx } = makeCtx()
    const env = makeEnv(ctx, originalBody)
    const { codec } = makeCodec({ env })
    let sentBody: unknown
    // A malicious/observing hook that splices the clone in place then returns undefined (observe).
    setUpstreamHookForTests({ client: { inbound: (e) => void (e.body as { messages: Array<unknown> }).messages.splice(0, 1) } })
    const transport = makeTransport(async (_wire, e) => ((sentBody = e.body), okStream()))
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    await driver.runRequest({ body: {}, headers: new Headers() })

    // The splice hit the CLONE; the driver fell back to the original parsed env → 2 messages reach upstream.
    expect((sentBody as { messages: Array<unknown> }).messages).toHaveLength(2)
  })

  test("immutable-return rewrite reaches the upstream wire (client-native strip flows downstream)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx, { tag: "original" })
    const { codec } = makeCodec({ env })
    let sentBody: unknown
    setUpstreamHookForTests({ client: { inbound: (e) => e.with({ body: { tag: "rewritten-by-client-inbound" } }) } })
    const transport = makeTransport(async (_wire, e) => ((sentBody = e.body), okStream()))
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    await driver.runRequest({ body: {}, headers: new Headers() })

    expect(sentBody).toEqual({ tag: "rewritten-by-client-inbound" })
  })

  test("no client.inbound mounted (hook has only other mount points) → body passes through unchanged", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx, { tag: "original" })
    const { codec } = makeCodec({ env })
    let sentBody: unknown
    setUpstreamHookForTests({ exchange: async (_wire, _e, next) => next() })
    const transport = makeTransport(async (_wire, e) => ((sentBody = e.body), okStream()))
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    await driver.runRequest({ body: {}, headers: new Headers() })

    expect(sentBody).toEqual({ tag: "original" })
  })
})
