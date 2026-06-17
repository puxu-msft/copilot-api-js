/**
 * v4 — legacy→env strategy adapter unit tests.
 *
 * Drives `adaptLegacyStrategy` with a mock legacy `RetryStrategy<TPayload>`,
 * asserting the action mapping (retry → env.with(body/prepareHints), abort →
 * {kind:"abort"}), meta surfacing, the shared attempt counter, and waitMs/learning
 * passthrough. Also a light check that `buildOpenAiCcStrategies` yields the
 * ordered CC strategies.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { RetryStrategy as LegacyRetryStrategy } from "~/lib/request/pipeline"

import {
  //
  adaptLegacyStrategy,
  type AttemptRef,
} from "~/lib/pipeline/legacy-strategy-adapter"

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

describe("adaptLegacyStrategy", () => {
  test("retry: maps legacy payload → env.with(body) + prepareHints, passes waitMs/learning", async () => {
    const legacy: LegacyRetryStrategy<P> = {
      name: "mock",
      canHandle: () => true,
      handle: (_e, payload) =>
        Promise.resolve({ action: "retry", payload: { v: payload.v + 1 }, waitMs: 7, prepareHints: { excludeBetas: ["b1"] }, learning: true }),
    }
    const attemptRef: AttemptRef = { value: 0 }
    const env = makeEnv({ v: 10 })
    const adapted = adaptLegacyStrategy(legacy, { attemptRef, originalPayload: { v: 0 }, model: undefined, maxRetries: 3 })

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

  test("abort: maps legacy abort → { kind: 'abort' }", async () => {
    const abortErr = { type: "bad_request", message: "nope" } as unknown as ApiError
    const legacy: LegacyRetryStrategy<P> = {
      name: "mock",
      canHandle: () => true,
      handle: () => Promise.resolve({ action: "abort", error: abortErr }),
    }
    const adapted = adaptLegacyStrategy(legacy, { attemptRef: { value: 0 }, originalPayload: { v: 0 }, model: undefined, maxRetries: 3 })
    const action = await adapted.handle(ERR, makeEnv({ v: 1 }))
    expect(action.kind).toBe("abort")
    if (action.kind === "abort") expect(action.error).toBe(abortErr)
  })

  test("surfaces action.meta via onMeta", async () => {
    const legacy: LegacyRetryStrategy<P> = {
      name: "mock",
      canHandle: () => true,
      handle: (_e, p) => Promise.resolve({ action: "retry", payload: p, meta: { truncateResult: { wasTruncated: true } } }),
    }
    let captured: Record<string, unknown> | undefined
    const adapted = adaptLegacyStrategy(legacy, {
      attemptRef: { value: 0 },
      originalPayload: { v: 0 },
      model: undefined,
      maxRetries: 3,
      onMeta: (m) => (captured = m),
    })
    await adapted.handle(ERR, makeEnv({ v: 1 }))
    expect(captured).toEqual({ truncateResult: { wasTruncated: true } })
  })

  test("legacy context carries the stable originalPayload baseline + shared attempt", async () => {
    const seen: Array<{ attempt: number; original: P }> = []
    const legacy: LegacyRetryStrategy<P> = {
      name: "mock",
      canHandle: () => true,
      handle: (_e, p, ctx) => {
        seen.push({ attempt: ctx.attempt, original: ctx.originalPayload })
        return Promise.resolve({ action: "retry", payload: p })
      },
    }
    const attemptRef: AttemptRef = { value: 0 }
    const baseline = { v: 999 }
    const adapted = adaptLegacyStrategy(legacy, { attemptRef, originalPayload: baseline, model: undefined, maxRetries: 5 })
    await adapted.handle(ERR, makeEnv({ v: 1 }))
    await adapted.handle(ERR, makeEnv({ v: 2 }))
    expect(seen[0]).toEqual({ attempt: 0, original: { v: 999 } })
    expect(seen[1]).toEqual({ attempt: 1, original: { v: 999 } }) // baseline stable, attempt advanced
  })
})

describe("buildOpenAiCcStrategies", () => {
  test("yields network → token-refresh → auto-truncate in order", async () => {
    const { buildOpenAiCcStrategies } = await import("~/lib/codec/openai-cc-strategies")
    const strategies = buildOpenAiCcStrategies({
      originalPayload: { model: "gpt-4o", messages: [] },
      model: undefined,
      maxRetries: 5,
      label: "Completions",
    })
    expect(strategies.map((s) => s.name)).toEqual(["network-retry", "token-refresh", "auto-truncate"])
  })
})
