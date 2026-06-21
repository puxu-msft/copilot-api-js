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

function makeCodec(parsedBody: unknown, decide?: RouteDecision): FormatCodec {
  return {
    format: "anthropic",
    parse: () => makeEnv(parsedBody),
    decideRoute: () => decide ?? ({ kind: "passthrough", endpoint: "/v1/messages" } as RouteDecision),
    translateOut: (env: RequestEnvelope) => env,
    renderResponse: (frame: unknown) => frame,
    renderResponseNonStreaming: (upstream: unknown) => upstream,
  } as unknown as FormatCodec
}

const transport = {
  send: () => {
    throw new Error("inspectRequest must never enter S4 / call transport")
  },
} as unknown as Transport

const RAW = { body: {}, headers: new Headers(), path: "/v1/messages", method: "POST" } as unknown as RawHttpRequest

function driverWith(codec: FormatCodec, requestRewrites: ReadonlyArray<RequestRewrite> = []) {
  return createPipelineDriver({ codec, transport, strategies: [], maxRetries: 0, maxLearningRetries: 0, requestRewrites })
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
})
