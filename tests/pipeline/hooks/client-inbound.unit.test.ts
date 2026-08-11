/**
 * Phase 4 (RFC 2026-07-14-symmetric-four-point-hooks §3/§3.5) — the `client.inbound` mount point.
 *
 * `client.inbound` is a ONE-SHOT client-NATIVE request rewrite the driver runs at S1a→S1b (after `codec.parse`, before `translateInbound`/route), the only stage where every format's body is client-native. These tests exercise the DRIVER WIRING directly — NOT `clientRequest` history as an oracle (real codecs already structuredClone the history snapshot, so it is blind to what the driver hands the hook).
 *
 * CONTRACT CHANGE 2026-08-11: the driver used to hand this hook a `snapshotBody` clone so an in-place write could not propagate (review HIGH-2 / §3.5 decision 4). Envelope scopes are mutable now and the core does not defend itself against hooks, so the hook sees — and can write — the live envelope.
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
import { writeAttempt } from "~/lib/pipeline/envelope"
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
  test("the hook receives the parse env's own body, not a defensive clone", async () => {
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
    setUpstreamHookForTests({ client: { inbound: (e) => ((seenBody = e.attempt.body), undefined) } })
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport: makeTransport(async () => okStream()) })

    await driver.runRequest({ body: {}, headers: new Headers() })

    // CONTRACT CHANGE 2026-08-11: this used to assert `not.toBe` and was the load-bearing proof that the driver handed the hook a `snapshotBody` clone. That defensive clone is gone — the core trusts hooks — so the hook now observes the very object the codec's parse produced.
    expect(seenBody).toBe(originalBody)
    expect(seenBody).toEqual(originalBody)
  })

  test("in-place mutation + `undefined` return REACHES the wire — the core trusts the hook", async () => {
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
    // A hook that splices the body in place and returns undefined — "I already wrote what I wanted".
    setUpstreamHookForTests({ client: { inbound: (e) => void (e.attempt.body as { messages: Array<unknown> }).messages.splice(0, 1) } })
    const transport = makeTransport(async (_wire, e) => ((sentBody = e.attempt.body), okStream()))
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    await driver.runRequest({ body: {}, headers: new Headers() })

    // CONTRACT CHANGE 2026-08-11: the pre-mutability driver handed this hook a `snapshotBody` clone so the splice hit a throwaway and 2 messages still reached upstream (review HIGH-2 / §3.5 decision 4). Envelope scopes are mutable now and the core does not defend itself against hooks, so the splice lands: 1 message reaches upstream.
    expect((sentBody as { messages: Array<unknown> }).messages).toHaveLength(1)
  })

  test("immutable-return rewrite reaches the upstream wire (client-native strip flows downstream)", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx, { tag: "original" })
    const { codec } = makeCodec({ env })
    let sentBody: unknown
    setUpstreamHookForTests({ client: { inbound: (e) => writeAttempt(e, { body: { tag: "rewritten-by-client-inbound" } }) } })
    const transport = makeTransport(async (_wire, e) => ((sentBody = e.attempt.body), okStream()))
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
    const transport = makeTransport(async (_wire, e) => ((sentBody = e.attempt.body), okStream()))
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })

    await driver.runRequest({ body: {}, headers: new Headers() })

    expect(sentBody).toEqual({ tag: "original" })
  })
})
