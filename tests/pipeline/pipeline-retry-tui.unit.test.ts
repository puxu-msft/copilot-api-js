/**
 * Unit tests for `request.attempt_failed` bus emission from
 * `executeRequestPipeline`.
 *
 * Verifies that the pipeline calls `ctx.recordAttemptFailure` (which
 * publishes `request.attempt_failed { willRetry: true, ... }` on the bus)
 * for every retry-eligible failure AFTER the budget gate accepts the
 * retry. Sinks (ConsoleSink) render this as `[RETRY]` lines.
 *
 * Covers:
 *  - Single retry → one attempt_failed event with correct
 *    strategy/status/error/waitMs/learning.
 *  - Multiple retries across distinct strategies → one event each, indices
 *    in order.
 *  - Learning-probe retries carry `learning: true`.
 *  - First-attempt success → zero attempt_failed events.
 *  - Abort action → zero attempt_failed events (no retry was decided).
 *  - Pipeline run without a RequestContext → zero events (web_search hop).
 *  - Budget-exhausted retry → no extra event for the discarded action.
 *
 * Tests use a per-test bus + recording subscriber. No singleton mutation.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
} from "~/lib/observability"
import type {
  //
  FormatAdapter,
} from "~/lib/request/pipeline"
import type { RetryStrategy } from "~/lib/request/retry-types"

import { createRequestContextManager } from "~/lib/context/manager"
import { HTTPError } from "~/lib/error"
import { createBus } from "~/lib/observability"
import { executeRequestPipeline } from "~/lib/request/pipeline"

interface TestPayload {
  model: string
  marker?: string
}

type AttemptFailedEvent = Extract<ObservabilityEvent, { kind: "request.attempt_failed" }>

let bus: ObservabilityBus
let captured: Array<AttemptFailedEvent>

beforeEach(() => {
  bus = createBus()
  captured = []
  bus.subscribe(
    (event) => {
      captured.push(event as AttemptFailedEvent)
    },
    (event) => event.kind === "request.attempt_failed",
  )
})

function makeAdapter(executeFn: FormatAdapter<TestPayload>["execute"]): FormatAdapter<TestPayload> {
  return {
    format: "anthropic-messages",
    sanitize: (p) => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0 }),
    execute: executeFn,
    logPayloadSize: () => {},
  }
}

/** Trivial retry strategy that succeeds on the second attempt. */
function alwaysRetry(name: string, opts: { waitMs?: number; learning?: boolean } = {}): RetryStrategy<TestPayload> {
  return {
    name,
    canHandle: () => true,
    handle: async (_error, payload) => ({
      action: "retry",
      payload,
      ...(opts.waitMs !== undefined && { waitMs: opts.waitMs }),
      ...(opts.learning !== undefined && { learning: opts.learning }),
    }),
  }
}

/** Strategy that aborts on every error. */
function alwaysAbort(name: string): RetryStrategy<TestPayload> {
  return {
    name,
    canHandle: () => true,
    handle: async (error) => ({ action: "abort", error }),
  }
}

const basePayload: TestPayload = { model: "gpt-test" }

function newCtxWithPublisher() {
  const manager = createRequestContextManager({ publisher: bus.scope("request") })
  const ctx = manager.create({ endpoint: "anthropic-messages" })
  ctx.setOriginalRequest({ model: "gpt-test", messages: [], stream: false, payload: {} })
  return ctx
}

describe("executeRequestPipeline → request.attempt_failed bus emission", () => {
  test("emits a single attempt_failed event with correct fields when one retry succeeds", async () => {
    const reqCtx = newCtxWithPublisher()
    let callCount = 0
    const adapter = makeAdapter(
      mock(async (p: TestPayload) => {
        callCount++
        if (callCount === 1) throw new HTTPError("Network reset", 502, "")
        return { result: { ok: true, marker: p.marker }, queueWaitMs: 0 }
      }),
    )

    const result = await executeRequestPipeline({
      adapter,
      strategies: [alwaysRetry("network-retry", { waitMs: 1000 })],
      payload: basePayload,
      originalPayload: basePayload,
      model: undefined,
      maxRetries: 3,
      requestContext: reqCtx,
    })

    expect(result.totalRetries).toBe(1)
    expect(captured).toHaveLength(1)
    const evt = captured[0]
    expect(evt.willRetry).toBe(true)
    expect(evt.nextStrategy).toBe("network-retry")
    expect(evt.waitMs).toBe(1000)
    expect(evt.learning).toBe(false)
    expect(evt.attempt.error?.status).toBe(502)
    expect(evt.attempt.error?.message).toContain("Network reset")
  })

  test("emits one event per attempt across multiple distinct strategies", async () => {
    const reqCtx = newCtxWithPublisher()
    let callCount = 0
    const adapter = makeAdapter(
      mock(async () => {
        callCount++
        if (callCount === 1) throw new HTTPError("ECONNRESET", 502, "")
        if (callCount === 2) throw new HTTPError("Too large", 413, "")
        return { result: "ok", queueWaitMs: 0 }
      }),
    )

    const strat1: RetryStrategy<TestPayload> = {
      name: "network-retry",
      canHandle: (e) => e.status === 502,
      handle: async (_e, p) => ({ action: "retry", payload: p, waitMs: 1000 }),
    }
    const strat2: RetryStrategy<TestPayload> = {
      name: "auto-truncate",
      canHandle: (e) => e.status === 413,
      handle: async (_e, p) => ({ action: "retry", payload: p }),
    }

    const result = await executeRequestPipeline({
      adapter,
      strategies: [strat1, strat2],
      payload: basePayload,
      originalPayload: basePayload,
      model: undefined,
      maxRetries: 5,
      requestContext: reqCtx,
    })

    expect(result.totalRetries).toBe(2)
    expect(captured).toHaveLength(2)
    expect(captured[0].nextStrategy).toBe("network-retry")
    expect(captured[0].attempt.error?.status).toBe(502)
    expect(captured[1].nextStrategy).toBe("auto-truncate")
    expect(captured[1].attempt.error?.status).toBe(413)
  })

  test("learning-probe retries carry learning:true", async () => {
    const reqCtx = newCtxWithPublisher()
    let callCount = 0
    const adapter = makeAdapter(
      mock(async () => {
        callCount++
        if (callCount === 1) throw new HTTPError("invalid beta flag", 400, JSON.stringify({ message: "invalid beta flag" }))
        return { result: "ok", queueWaitMs: 0 }
      }),
    )

    await executeRequestPipeline({
      adapter,
      strategies: [alwaysRetry("unsupported-beta-retry", { learning: true })],
      payload: basePayload,
      originalPayload: basePayload,
      model: undefined,
      maxRetries: 0, // learning retries draw from a separate budget
      requestContext: reqCtx,
    })

    expect(captured).toHaveLength(1)
    expect(captured[0].learning).toBe(true)
    expect(captured[0].nextStrategy).toBe("unsupported-beta-retry")
  })

  test("first-attempt success emits no attempt_failed event", async () => {
    const reqCtx = newCtxWithPublisher()
    const adapter = makeAdapter(mock(async () => ({ result: "ok", queueWaitMs: 0 })))

    await executeRequestPipeline({
      adapter,
      strategies: [alwaysRetry("would-retry")],
      payload: basePayload,
      originalPayload: basePayload,
      model: undefined,
      maxRetries: 3,
      requestContext: reqCtx,
    })

    expect(captured).toHaveLength(0)
  })

  test("abort action emits no attempt_failed event", async () => {
    const reqCtx = newCtxWithPublisher()
    const adapter = makeAdapter(
      mock(async () => {
        throw new HTTPError("Forbidden", 403, "")
      }),
    )

    await expect(
      executeRequestPipeline({
        adapter,
        strategies: [alwaysAbort("token-refresh")],
        payload: basePayload,
        originalPayload: basePayload,
        model: undefined,
        maxRetries: 3,
        requestContext: reqCtx,
      }),
    ).rejects.toThrow("Forbidden")

    expect(captured).toHaveLength(0)
  })

  test("missing requestContext suppresses attempt_failed events", async () => {
    let callCount = 0
    const adapter = makeAdapter(
      mock(async () => {
        callCount++
        if (callCount === 1) throw new HTTPError("Network reset", 502, "")
        return { result: "ok", queueWaitMs: 0 }
      }),
    )

    const result = await executeRequestPipeline({
      adapter,
      strategies: [alwaysRetry("network-retry")],
      payload: basePayload,
      originalPayload: basePayload,
      model: undefined,
      maxRetries: 3,
      // requestContext intentionally omitted (mirrors web_search internal hops)
    })

    expect(result.totalRetries).toBe(1)
    expect(captured).toHaveLength(0)
  })

  test("budget-exhausted retry produces no extra attempt_failed event", async () => {
    const reqCtx = newCtxWithPublisher()
    const executeFn = mock(async () => {
      throw new HTTPError("Network reset", 502, "")
    })
    const adapter = makeAdapter(executeFn)

    await expect(
      executeRequestPipeline({
        adapter,
        strategies: [alwaysRetry("network-retry")],
        payload: basePayload,
        originalPayload: basePayload,
        model: undefined,
        maxRetries: 1,
        requestContext: reqCtx,
      }),
    ).rejects.toThrow("Network reset")

    // 1 initial + 1 retry = 2 calls (budget exhausted before a 3rd)
    expect(executeFn).toHaveBeenCalledTimes(2)
    // Only the accepted retry emitted; the budget-rejected one did not.
    expect(captured).toHaveLength(1)
  })
})
