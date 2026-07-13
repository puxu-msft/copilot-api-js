/**
 * Unit tests for the new RequestContext emit methods added in commit 3a.
 *
 * Verifies:
 * - `setResolvedModel` mutates `resolvedModel` / `clientModel` AND publishes
 *   `request.model_resolved` when a publisher is injected.
 * - `recordFeature` publishes `request.feature_applied` (no ctx mutation).
 * - `recordStreamProgress` publishes `request.stream_progress` with only
 *   the fields actually passed (no undefined fields leak through).
 * - `recordAttemptStart` publishes `request.attempt_started` with the
 *   AttemptSnapshot.
 * - `recordAttemptFailure` snapshots the current attempt (wireRequest /
 *   effectiveRequest / response / error) into AttemptSnapshot and publishes
 *   `request.attempt_failed`.
 * - `failIfNotFinalized` is a no-op when settled, delegates to fail() otherwise.
 * - `completeFromHttpStatus` routes 2xx → complete(), 4xx+ → fail().
 * - When `publisher` is undefined (legacy call site), methods mutate state
 *   but do NOT publish (verified by a sentinel — bus subscribe count 0).
 *
 * Tests own a per-test bus (via `createBus()`) — no singleton mutation,
 * no `mock.module`, no global state.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ObservabilityEvent } from "~/lib/observability"

import { createRequestContext } from "~/lib/context/request"
import { HTTPError } from "~/lib/error"
import { createBus } from "~/lib/observability"

/**
 * Build a RequestContext + bus + recording subscriber. Returns the recorded
 * `request.*` bus events (the single event channel since P0.3).
 */
function setup(opts?: { publisher?: boolean; method?: string; path?: string }) {
  const bus = createBus()
  const events: Array<ObservabilityEvent> = []
  bus.subscribe((e) => {
    events.push(e)
  })

  const ctx = createRequestContext({
    endpoint: "anthropic-messages",
    method: opts?.method ?? "POST",
    path: opts?.path ?? "/v1/messages",
    publisher: opts?.publisher === false ? undefined : bus.scope("request"),
  })
  return { bus, ctx, events }
}

describe("RequestContext.setResolvedModel", () => {
  test("mutates resolvedModel + clientModel and publishes request.model_resolved", () => {
    const { ctx, events } = setup()
    ctx.setResolvedModel({ resolved: "claude-opus-4.8", client: "opus" })

    expect(ctx.resolvedModel).toBe("claude-opus-4.8")
    expect(ctx.clientModel).toBe("opus")
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("request.model_resolved")
    if (events[0].kind === "request.model_resolved") {
      expect(events[0].ctx.resolvedModel).toBe("claude-opus-4.8")
      expect(events[0].ctx.clientModel).toBe("opus")
    }
  })

  test("publishes without clientModel when omitted", () => {
    const { ctx, events } = setup()
    ctx.setResolvedModel({ resolved: "claude-opus-4.8" })
    expect(ctx.clientModel).toBeNull()
    if (events[0].kind === "request.model_resolved") {
      expect(events[0].ctx.clientModel).toBeUndefined()
    }
  })

  test("when publisher is undefined, mutates state but does NOT publish", () => {
    const { ctx, events } = setup({ publisher: false })
    ctx.setResolvedModel({ resolved: "claude-opus-4.8", client: "opus" })
    expect(ctx.resolvedModel).toBe("claude-opus-4.8")
    expect(events).toHaveLength(0)
  })
})

describe("RequestContext.recordFeature", () => {
  test("publishes request.feature_applied with detail", () => {
    const { ctx, events } = setup()
    ctx.recordFeature("beta-stripped", { betas: ["prompt-caching"] })
    expect(events).toHaveLength(1)
    if (events[0].kind === "request.feature_applied") {
      expect(events[0].feature).toBe("beta-stripped")
      expect(events[0].detail).toEqual({ betas: ["prompt-caching"] })
    }
  })

  test("omits detail field when undefined", () => {
    const { ctx, events } = setup()
    ctx.recordFeature("via-responses")
    if (events[0].kind === "request.feature_applied") {
      // `detail` should be absent (not undefined) on the published object.
      expect("detail" in events[0]).toBe(false)
    }
  })
})

describe("RequestContext.recordStreamProgress", () => {
  test("publishes only the fields actually passed", () => {
    const { ctx, events } = setup()
    ctx.recordStreamProgress({ bytesIn: 1024, eventsIn: 8 })
    if (events[0].kind === "request.stream_progress") {
      expect(events[0].bytesIn).toBe(1024)
      expect(events[0].eventsIn).toBe(8)
      expect("blockType" in events[0]).toBe(false)
    }
  })

  test("blockType only, bytes/events omitted", () => {
    const { ctx, events } = setup()
    ctx.recordStreamProgress({ blockType: "thinking" })
    if (events[0].kind === "request.stream_progress") {
      expect(events[0].blockType).toBe("thinking")
      expect("bytesIn" in events[0]).toBe(false)
    }
  })
})

describe("RequestContext.recordAttemptStart", () => {
  test("publishes request.attempt_started with snapshot", () => {
    const { ctx, events } = setup()
    ctx.recordAttemptStart({ attemptIndex: 0, strategy: "network-retry", transport: "http" })
    if (events[0].kind === "request.attempt_started") {
      expect(events[0].attempt.attemptIndex).toBe(0)
      expect(events[0].attempt.strategy).toBe("network-retry")
      expect(events[0].attempt.transport).toBe("http")
    }
  })
})

describe("RequestContext.recordAttemptFailure", () => {
  test("snapshots current attempt's error / strategy / requests", () => {
    const { ctx, events } = setup()
    // Build up a realistic attempt state via the legacy API
    ctx.beginAttempt({ strategy: "auto-truncate" })
    ctx.setAttemptError({ status: 413, message: "Payload too large", type: "payload_too_large", raw: null as never })

    ctx.recordAttemptFailure({ willRetry: true, nextStrategy: "auto-truncate", waitMs: 1000 })

    // `beginAttempt` publishes a `request.context_updated` at index 0, so select
    // the attempt_failed event robustly instead of assuming it lands at events[0].
    const failed = events.find((e) => e.kind === "request.attempt_failed")
    expect(failed).toBeDefined()
    if (failed?.kind === "request.attempt_failed") {
      expect(failed.willRetry).toBe(true)
      expect(failed.nextStrategy).toBe("auto-truncate")
      expect(failed.waitMs).toBe(1000)
      expect(failed.attempt.attemptIndex).toBe(0)
      expect(failed.attempt.strategy).toBe("auto-truncate")
      // Non-HTTPError `raw` (null) yields an error object with NO `rawBody` — the
      // negative-case guard for H1's rawBody field.
      expect(failed.attempt.error).toEqual({ status: 413, message: "Payload too large", type: "payload_too_large" })
    }
  })

  test("carries the upstream error rawBody from the attempt's HTTPError raw", () => {
    const { ctx, events } = setup()
    const body = '{"error":{"message":"upstream boom","type":"server_error"}}'
    ctx.beginAttempt({ strategy: "server-error-retry" })
    ctx.setAttemptError({
      status: 500,
      message: "HTTP 500",
      type: "server_error",
      raw: new HTTPError("HTTP 500", 500, body),
    })

    ctx.recordAttemptFailure({ willRetry: true })

    const failed = events.find((e) => e.kind === "request.attempt_failed")
    expect(failed).toBeDefined()
    if (failed?.kind === "request.attempt_failed") {
      expect(failed.attempt.error?.rawBody).toBe(body)
    }
  })

  test("works without any prior attempt (snapshot has index 0 + no error)", () => {
    const { ctx, events } = setup()
    ctx.recordAttemptFailure({ willRetry: false })
    const failed = events.find((e) => e.kind === "request.attempt_failed")
    expect(failed).toBeDefined()
    if (failed?.kind === "request.attempt_failed") {
      expect(failed.attempt.attemptIndex).toBe(0)
      expect(failed.attempt.error).toBeUndefined()
      expect(failed.willRetry).toBe(false)
    }
  })
})

describe("RequestContext.failIfNotFinalized", () => {
  test("calls fail() when not yet settled", () => {
    const { ctx, events } = setup()
    ctx.setResolvedModel({ resolved: "claude-opus-4.8" })
    ctx.failIfNotFinalized(new Error("handler threw"))
    expect(ctx.settled).toBe(true)
    expect(ctx.state).toBe("failed")
    expect(events.some((e) => e.kind === "request.failed")).toBe(true)
  })

  test("is a no-op when already settled", () => {
    const { ctx, events } = setup()
    ctx.complete({
      success: true,
      model: "claude-opus-4.8",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: null,
    })
    const eventsBefore = events.length
    ctx.failIfNotFinalized(new Error("late"))
    expect(events.length).toBe(eventsBefore) // no new emit
    expect(ctx.state).toBe("completed") // still completed, not flipped
  })
})

describe("RequestContext.completeFromHttpStatus", () => {
  test("2xx → complete()", () => {
    const { ctx, events } = setup()
    ctx.setResolvedModel({ resolved: "claude-opus-4.8" })
    ctx.completeFromHttpStatus(200)
    expect(ctx.state).toBe("completed")
    expect(events.some((e) => e.kind === "request.completed")).toBe(true)
  })

  test("4xx → fail()", () => {
    const { ctx, events } = setup()
    ctx.setResolvedModel({ resolved: "claude-opus-4.8" })
    ctx.completeFromHttpStatus(429)
    expect(ctx.state).toBe("failed")
    expect(events.some((e) => e.kind === "request.failed")).toBe(true)
  })

  test("is a no-op when already settled", () => {
    const { ctx } = setup()
    ctx.complete({
      success: true,
      model: "claude-opus-4.8",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: null,
    })
    ctx.completeFromHttpStatus(500) // would normally flip to failed
    expect(ctx.state).toBe("completed") // still completed
  })
})

describe("RequestContextSnapshot fields", () => {
  test("method / path / requestBodySize / multiplier / resolvedModel survive snapshot", () => {
    const bus = createBus()
    const events: Array<ObservabilityEvent> = []
    bus.subscribe((e) => {
      events.push(e)
    })
    const ctx = createRequestContext({
      endpoint: "openai-chat-completions",
      method: "POST",
      path: "/chat/completions",
      requestBodySize: 4096,
      publisher: bus.scope("request"),
    })
    expect(ctx.method).toBe("POST")
    expect(ctx.path).toBe("/chat/completions")
    expect(ctx.requestBodySize).toBe(4096)

    ctx.setResolvedModel({ resolved: "gpt-4o" })
    if (events[0].kind === "request.model_resolved") {
      expect(events[0].ctx.method).toBe("POST")
      expect(events[0].ctx.path).toBe("/chat/completions")
      expect(events[0].ctx.requestBodySize).toBe(4096)
      expect(events[0].ctx.resolvedModel).toBe("gpt-4o")
    }
  })

  test("defaults: method='UNKNOWN', path='/' when omitted", () => {
    const bus = createBus()
    const events: Array<ObservabilityEvent> = []
    bus.subscribe((e) => {
      events.push(e)
    })
    const ctx = createRequestContext({
      endpoint: "anthropic-messages",
      publisher: bus.scope("request"),
    })
    expect(ctx.method).toBe("UNKNOWN")
    expect(ctx.path).toBe("/")
    expect(ctx.requestBodySize).toBeUndefined()
  })
})
