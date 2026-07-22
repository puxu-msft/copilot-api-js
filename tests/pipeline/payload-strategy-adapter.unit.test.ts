/**
 * v4 payload→envelope strategy adapter unit tests.
 *
 * Drives `adaptPayloadStrategy` with a mock payload `RetryStrategy<TPayload>`,
 * asserting the action mapping (retry → env.with(body/prepareHints), abort →
 * {kind:"abort"}), meta attached to the env-action (C0-②, not fired immediately),
 * onResolved meta forwarding into the payload ResolvedContext, the shared attempt
 * counter, and waitMs/learning passthrough. Also a light check that
 * `buildOpenAiCcStrategies` yields the ordered CC strategies.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { RetryStrategy as PayloadRetryStrategy } from "~/lib/request/retry-types"

import {
  //
  adaptPayloadStrategy,
  type AttemptRef,
} from "~/lib/pipeline/payload-strategy-adapter"

interface P {
  v: number
}

function makeEnv(body: P): RequestEnvelope {
  return {
    body,
    prepareHints: {},
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

const ERR = { type: "network_error", message: "boom" } as unknown as ApiError

describe("adaptPayloadStrategy", () => {
  test("retry: maps payload → env.with(body) + prepareHints, passes waitMs/learning", async () => {
    const payloadStrategy: PayloadRetryStrategy<P> = {
      name: "mock",
      canHandle: () => true,
      handle: (_e, payload) =>
        Promise.resolve({ action: "retry", payload: { v: payload.v + 1 }, waitMs: 7, prepareHints: { excludeBetas: ["b1"] }, learning: true }),
    }
    const attemptRef: AttemptRef = { value: 0 }
    const env = makeEnv({ v: 10 })
    const adapted = adaptPayloadStrategy(payloadStrategy, { attemptRef, originalPayload: { v: 0 }, model: undefined, maxRetries: 3 })

    expect(adapted.name).toBe("mock")
    expect(adapted.canHandle(ERR)).toBe(true)
    const action = await adapted.handle(ERR, env)
    expect(action.kind).toBe("retry")
    if (action.kind === "retry") {
      expect((action.env.body as P).v).toBe(11)
      expect(action.env.prepareHints).toEqual({ excludeBetas: ["b1"] })
      expect(action.waitMs).toBe(7)
      expect(action.learning).toBe(true)
    }
    expect(attemptRef.value).toBe(1) // incremented after handle
  })

  test("abort: maps payload abort → { kind: 'abort' }", async () => {
    const abortErr = { type: "bad_request", message: "nope" } as unknown as ApiError
    const payloadStrategy: PayloadRetryStrategy<P> = {
      name: "mock",
      canHandle: () => true,
      handle: () => Promise.resolve({ action: "abort", error: abortErr }),
    }
    const adapted = adaptPayloadStrategy(payloadStrategy, { attemptRef: { value: 0 }, originalPayload: { v: 0 }, model: undefined, maxRetries: 3 })
    const action = await adapted.handle(ERR, makeEnv({ v: 1 }))
    expect(action.kind).toBe("abort")
    if (action.kind === "abort") expect(action.error).toBe(abortErr)
  })

  test("attaches action.meta to the env-action (C0-②: the driver fires it post-gate, the adapter does NOT)", async () => {
    const payloadStrategy: PayloadRetryStrategy<P> = {
      name: "mock",
      canHandle: () => true,
      handle: (_e, p) => Promise.resolve({ action: "retry", payload: p, meta: { probedBetas: ["beta-x"] } }),
    }
    const adapted = adaptPayloadStrategy(payloadStrategy, { attemptRef: { value: 0 }, originalPayload: { v: 0 }, model: undefined, maxRetries: 3 })
    const action = await adapted.handle(ERR, makeEnv({ v: 1 }))
    expect(action.kind).toBe("retry")
    if (action.kind === "retry") expect(action.meta).toEqual({ probedBetas: ["beta-x"] })
  })

  test("omits meta on the env-action when the payload action carries none", async () => {
    const payloadStrategy: PayloadRetryStrategy<P> = {
      name: "mock",
      canHandle: () => true,
      handle: (_e, p) => Promise.resolve({ action: "retry", payload: p }),
    }
    const adapted = adaptPayloadStrategy(payloadStrategy, { attemptRef: { value: 0 }, originalPayload: { v: 0 }, model: undefined, maxRetries: 3 })
    const action = await adapted.handle(ERR, makeEnv({ v: 1 }))
    if (action.kind === "retry") expect(action.meta).toBeUndefined()
  })

  test("onResolved forwards the driver-supplied meta into the payload ResolvedContext (RFC §12.2)", async () => {
    const seen: Array<{ payload: P; meta: Record<string, unknown> | undefined; attempt: number }> = []
    const payloadStrategy: PayloadRetryStrategy<P> = {
      name: "mock",
      canHandle: () => true,
      handle: (_e, p) => Promise.resolve({ action: "retry", payload: p }),
      onResolved: (ctx) => {
        seen.push({ payload: ctx.payload, meta: ctx.meta, attempt: ctx.attempt })
      },
    }
    const attemptRef: AttemptRef = { value: 2 }
    const adapted = adaptPayloadStrategy(payloadStrategy, { attemptRef, originalPayload: { v: 0 }, model: undefined, maxRetries: 3 })
    await adapted.onResolved?.(makeEnv({ v: 5 }), { probedBetas: ["beta-x"] })
    expect(seen).toEqual([{ payload: { v: 5 }, meta: { probedBetas: ["beta-x"] }, attempt: 2 }])
  })

  test("onResolved is absent on the adapted strategy when the payload strategy has none", () => {
    const payloadStrategy: PayloadRetryStrategy<P> = {
      name: "mock",
      canHandle: () => true,
      handle: (_e, p) => Promise.resolve({ action: "retry", payload: p }),
    }
    const adapted = adaptPayloadStrategy(payloadStrategy, { attemptRef: { value: 0 }, originalPayload: { v: 0 }, model: undefined, maxRetries: 3 })
    expect(adapted.onResolved).toBeUndefined()
  })

  test("payload context carries the stable originalPayload baseline + shared attempt", async () => {
    const seen: Array<{ attempt: number; original: P }> = []
    const payloadStrategy: PayloadRetryStrategy<P> = {
      name: "mock",
      canHandle: () => true,
      handle: (_e, p, ctx) => {
        seen.push({ attempt: ctx.attempt, original: ctx.originalPayload })
        return Promise.resolve({ action: "retry", payload: p })
      },
    }
    const attemptRef: AttemptRef = { value: 0 }
    const baseline = { v: 999 }
    const adapted = adaptPayloadStrategy(payloadStrategy, { attemptRef, originalPayload: baseline, model: undefined, maxRetries: 5 })
    await adapted.handle(ERR, makeEnv({ v: 1 }))
    await adapted.handle(ERR, makeEnv({ v: 2 }))
    expect(seen[0]).toEqual({ attempt: 0, original: { v: 999 } })
    expect(seen[1]).toEqual({ attempt: 1, original: { v: 999 } }) // baseline stable, attempt advanced
  })
})

describe("buildOpenAiCcStrategies", () => {
  test("yields network → server-error → token-refresh in order", async () => {
    const { buildOpenAiCcStrategies } = await import("~/lib/codec/openai-cc/strategies")
    const strategies = buildOpenAiCcStrategies({
      originalPayload: { model: "gpt-4o", messages: [] },
      model: undefined,
      maxRetries: 5,
    })
    expect(strategies.map((s) => s.name)).toEqual(["network-retry", "server-error-retry", "token-refresh"])
  })
})
