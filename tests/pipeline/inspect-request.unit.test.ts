/**
 * Unit tests for `driver.inspectRequest` — request-side S1→stopAfter inspection (RFC §4),
 * never entering S4. Minimal hand-built harness (mirrors driver.unit.test.ts).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { RequestRewrite } from "~/lib/pipeline/rewrite-registry"
import type {
  //
  FormatCodec,
  RawHttpRequest,
  RouteDecision,
  Transport,
} from "~/lib/pipeline/types"

import { createPipelineDriver } from "~/lib/pipeline/driver"

function makeEnv(body: unknown): RequestEnvelope {
  return {
    clientFormat: "anthropic",
    targetEndpoint: undefined,
    model: {},
    stream: false,
    body,
    view: {},
    prepareHints: {},
    ctx: {} as never,
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as unknown as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

// The mock carries a `decideRoute` closure on a side-channel (via intersection) — route
// decision is no longer a FormatCodec method (ADR 2026-07-11); `driverWith` wires it into the
// driver through the `deps.decideRoute` DI seam (correctness lives in router-golden.it.test.ts).
type MockCodec = FormatCodec & { decideRoute: (env: RequestEnvelope) => RouteDecision }

function makeCodec(parsedBody: unknown, decide?: RouteDecision): MockCodec {
  return {
    format: "anthropic",
    parse: () => makeEnv(parsedBody),
    decideRoute: () => decide ?? ({ kind: "passthrough", endpoint: "/v1/messages" } as RouteDecision),
    translateOut: (env: RequestEnvelope) => env,
    renderResponse: (frame: unknown) => frame,
    renderResponseNonStreaming: (upstream: unknown) => upstream,
  } as unknown as MockCodec
}

const transport = {
  send: () => {
    throw new Error("inspectRequest must never enter S4 / call transport")
  },
} as unknown as Transport

const RAW = { body: {}, headers: new Headers(), path: "/v1/messages", method: "POST" } as unknown as RawHttpRequest

function driverWith(codec: MockCodec, requestRewrites: ReadonlyArray<RequestRewrite> = []) {
  // Route decision moved to the free-function `router.decideRoute` (ADR 2026-07-11); this
  // orchestration test injects the mock codec's decision via the `deps.decideRoute` DI seam
  // (route-decision correctness is covered by router-golden.it.test.ts, not here).
  return createPipelineDriver({ codec, transport, strategies: [], maxRetries: 0, maxLearningRetries: 0, requestRewrites, decideRoute: (env) => codec.decideRoute(env) })
}

describe("driver.inspectRequest", () => {
  const appendRewrite: RequestRewrite = {
    name: "append-flag",
    order: 100,
    appliesTo: () => true,
    apply: (env: RequestEnvelope) => ({ env: env.with({ body: { ...(env.body as Record<string, unknown>), rewritten: true } }), changed: true }),
  } as unknown as RequestRewrite

  test("runs S1-S3, snapshots each stage + records per-rewrite {name, changed}", () => {
    const r = driverWith(makeCodec({ orig: 1 }), [appendRewrite]).inspectRequest(RAW, "rewrite-in")
    expect(r.stoppedAt).toBe("rewrite-in")
    expect(r.stages.parse?.body).toEqual({ orig: 1 })
    expect(r.stages.parse?.clientFormat).toBe("anthropic")
    expect(r.stages.translate?.targetEndpoint).toBe("/v1/messages")
    expect(r.stages["rewrite-in"]?.applied).toEqual([{ name: "append-flag", changed: true }])
    expect(r.stages["rewrite-in"]?.body).toEqual({ orig: 1, rewritten: true })
  })

  test("stopAfter=parse stops before S2 (no translate/rewrite-in stages)", () => {
    const r = driverWith(makeCodec({ orig: 1 }), [appendRewrite]).inspectRequest(RAW, "parse")
    expect(r.stoppedAt).toBe("parse")
    expect(r.stages.parse).toBeDefined()
    expect(r.stages.translate).toBeUndefined()
    expect(r.stages["rewrite-in"]).toBeUndefined()
  })

  test("stopAfter=translate stops before S3", () => {
    const r = driverWith(makeCodec({ orig: 1 }), [appendRewrite]).inspectRequest(RAW, "translate")
    expect(r.stoppedAt).toBe("translate")
    expect(r.stages.translate).toBeDefined()
    expect(r.stages["rewrite-in"]).toBeUndefined()
  })

  test("snapshots are deep — a later mutating rewrite does not perturb the parse snapshot", () => {
    const r = driverWith(makeCodec({ orig: 1 }), [appendRewrite]).inspectRequest(RAW, "rewrite-in")
    expect(r.stages.parse?.body).toEqual({ orig: 1 }) // not { orig:1, rewritten:true }
  })

  test("S2 reject → stoppedAt reject with status/reason, no translate stage", () => {
    const codec = makeCodec({ orig: 1 }, { kind: "reject", status: 400, reason: "unsupported model" } as RouteDecision)
    const r = driverWith(codec).inspectRequest(RAW, "rewrite-in")
    expect(r.stoppedAt).toBe("reject")
    expect(r.rejected).toEqual({ status: 400, reason: "unsupported model" })
    expect(r.stages.parse).toBeDefined()
    expect(r.stages.translate).toBeUndefined()
  })

  test("never calls transport (S4 short-circuited)", () => {
    // transport.send throws if called; reaching rewrite-in without throwing proves S4 is never entered.
    expect(() => driverWith(makeCodec({ orig: 1 }), [appendRewrite]).inspectRequest(RAW, "rewrite-in")).not.toThrow()
  })

  test("stopAfter=prepare-wire runs S4-pre wire prep on the post-rewrite env (note: first-attempt only)", () => {
    const codec = makeCodec({ orig: 1 })
    // S4-pre: the codec derives the wire from the (post-S3) env. Non-pure in real codecs
    // (betaProbe.recordOutbound / ctx.recordFeature) — the endpoint isolates that with a
    // throwaway probe + capturing ctx; the mock here just proves the driver calls it last.
    ;(codec as { prepareWire: FormatCodec["prepareWire"] }).prepareWire = (env) => ({
      url: "https://up/v1/messages",
      headers: new Headers({ "x-beta": "b" }),
      body: { wire: true, from: env.body as Record<string, unknown> },
      stream: false,
    })
    const r = driverWith(codec, [appendRewrite]).inspectRequest(RAW, "prepare-wire")
    expect(r.stoppedAt).toBe("prepare-wire")
    // S3 still ran before S4-pre (the wire is derived from the rewritten body).
    expect(r.stages["rewrite-in"]?.applied).toEqual([{ name: "append-flag", changed: true }])
    expect(r.stages["prepare-wire"]?.url).toBe("https://up/v1/messages")
    expect(r.stages["prepare-wire"]?.body).toEqual({ wire: true, from: { orig: 1, rewritten: true } })
    expect(r.stages["prepare-wire"]?.headers).toMatchObject({ "x-beta": "b" })
    expect(r.stages["prepare-wire"]?.note).toContain("first-attempt only")
  })

  test("stopAfter=prepare-wire never calls transport either", () => {
    const codec = makeCodec({ orig: 1 })
    ;(codec as { prepareWire: FormatCodec["prepareWire"] }).prepareWire = () => ({ url: "u", headers: new Headers(), body: {}, stream: false })
    expect(() => driverWith(codec).inspectRequest(RAW, "prepare-wire")).not.toThrow()
  })
})
