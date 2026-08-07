/**
 * Component tests for RequestContext state machine.
 *
 * Tests: createRequestContext, state transitions, attempts, events
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { EndpointType } from "~/lib/history/store"
import type { ObservabilityEvent } from "~/lib/observability"

import { createRequestContext } from "~/lib/context/request"
import { HTTPError } from "~/lib/error"
import { createBus } from "~/lib/observability"

/**
 * Build a RequestContext wired to a fresh per-test bus + recording subscriber.
 * Returns the recorded `request.*` events so tests assert on the bus stream
 * (the single event channel since P0.3).
 */
function makeContext(overrides?: { endpoint?: EndpointType }) {
  const bus = createBus()
  const events: Array<ObservabilityEvent> = []
  bus.subscribe((e) => {
    events.push(e)
  })
  const ctx = createRequestContext({
    endpoint: overrides?.endpoint ?? "anthropic-messages",
    publisher: bus.scope("request"),
  })
  return { ctx, events }
}

// ─── Initialization ───

describe("createRequestContext - initialization", () => {
  test("starts in pending state", () => {
    const { ctx } = makeContext()
    expect(ctx.state).toBe("pending")
  })

  test("generates unique id starting with req_", () => {
    const { ctx: ctx1 } = makeContext()
    const { ctx: ctx2 } = makeContext()
    expect(ctx1.id).toMatch(/^req_/)
    expect(ctx2.id).toMatch(/^req_/)
    expect(ctx1.id).not.toBe(ctx2.id)
  })

  test("stores endpoint type", () => {
    const { ctx } = makeContext({ endpoint: "openai-chat-completions" })
    expect(ctx.endpoint).toBe("openai-chat-completions")
  })

  test("initializes with null data fields and empty attempts", () => {
    const { ctx } = makeContext()
    expect(ctx.originalRequest).toBeNull()
    expect(ctx.response).toBeNull()
    expect(ctx.pipelineInfo).toBeNull()
    expect(ctx.endTime).toBeNull()
    expect(ctx.attempts).toHaveLength(0)
    expect(ctx.currentAttempt).toBeNull()
    expect(ctx.queueWaitMs).toBe(0)
    expect(ctx.settled).toBe(false)
  })

  test("computes durationMs from startTime", () => {
    const { ctx } = makeContext()
    expect(ctx.durationMs).toBeGreaterThanOrEqual(0)
  })
})

// ─── State transitions ───

describe("createRequestContext - state transitions", () => {
  test("transition() updates state", () => {
    const { ctx } = makeContext()
    ctx.transition("executing")
    expect(ctx.state).toBe("executing")

    ctx.transition("streaming")
    expect(ctx.state).toBe("streaming")
  })

  test("transition() fires state_changed event with previousState", () => {
    const { ctx, events } = makeContext()
    ctx.transition("executing", { reason: "test" })

    const lastCall = events.at(-1)!
    expect(lastCall.kind).toBe("request.state_changed")
    if (lastCall.kind === "request.state_changed") {
      expect(lastCall.previousState).toBe("pending")
      expect(lastCall.meta).toEqual({ reason: "test" })
      expect(lastCall.ctx.id).toBe(ctx.id)
    }
  })
})

// ─── Attempt lifecycle ───

describe("createRequestContext - attempt lifecycle", () => {
  test("beginAttempt creates attempt with index 0", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})

    expect(ctx.attempts).toHaveLength(1)
    expect(ctx.currentAttempt!.index).toBe(0)
  })

  test("subsequent beginAttempt increments index", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    ctx.beginAttempt({ strategy: "auto-truncate" })

    expect(ctx.attempts).toHaveLength(2)
    expect(ctx.currentAttempt!.index).toBe(1)
    expect(ctx.currentAttempt!.strategy).toBe("auto-truncate")
  })

  test("setAttemptSanitization stores on currentAttempt", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    ctx.setAttemptSanitization({
      totalBlocksRemoved: 3,
      systemReminderRemovals: 1,
      orphanedToolUseCount: 0,
      orphanedToolResultCount: 0,
      fixedNameCount: 0,
      emptyTextBlocksRemoved: 0,
      emptyThinkingBlocksRemoved: 0,
    })

    expect(ctx.currentAttempt!.sanitization).toEqual({
      totalBlocksRemoved: 3,
      systemReminderRemovals: 1,
      orphanedToolUseCount: 0,
      orphanedToolResultCount: 0,
      fixedNameCount: 0,
      emptyTextBlocksRemoved: 0,
      emptyThinkingBlocksRemoved: 0,
    })
  })

  test("setAttemptCacheControlStripped stores on currentAttempt (HIGH-1 per-attempt 持久化)", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    ctx.setAttemptCacheControlStripped(["scope"])
    expect(ctx.currentAttempt!.cacheControlStripped).toEqual(["scope"])
  })

  test("setAttemptCacheControlStripped 空数组 no-op（不建空标记）", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    ctx.setAttemptCacheControlStripped([])
    expect(ctx.currentAttempt!.cacheControlStripped).toBeUndefined()
  })

  test("setAttemptEffectiveRequest stores on currentAttempt", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    const effectiveReq = {
      model: "claude-sonnet-4",
      resolvedModel: undefined,
      messages: [{ role: "user", content: "hi" }],
      payload: {},
      format: "anthropic-messages" as const,
    }
    ctx.setAttemptEffectiveRequest(effectiveReq)

    expect(ctx.currentAttempt!.effectiveRequest).toBe(effectiveReq)
  })

  test("setAttemptWireRequest stores on currentAttempt", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    const wireReq = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      payload: { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }] },
      headers: { "anthropic-version": "2023-06-01" },
      format: "anthropic-messages" as const,
    }
    ctx.setAttemptWireRequest(wireReq)

    expect(ctx.currentAttempt!.wireRequest).toBe(wireReq)
  })

  test("records response failure supersession on the current dispatch and terminal snapshot", async () => {
    const { ctx } = makeContext()
    const candidate = ctx.beginGenerationCandidate({ role: "primary" })
    const dispatch = ctx.beginGenerationDispatch({ candidate })
    const supersededError = new Error("upstream failure")
    const flushError = new Error("flush failure")

    ctx.recordResponseFailureSupersession({ supersededError, supersededSource: "upstream-transport", flushError })
    expect(ctx.modelOperationSnapshot.dispatches.find((entry) => entry.handle === dispatch)?.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: "response.failure-supersession",
        data: {
          supersededError: expect.objectContaining({ message: "upstream failure" }),
          supersededSource: "upstream-transport",
          flushError: expect.objectContaining({ message: "flush failure" }),
        },
      }),
    )

    ctx.settleGenerationDispatch(dispatch, { verdict: "failed", error: flushError })
    ctx.settleGenerationCandidate(candidate, { verdict: "failed" })
    ctx.fail("test", flushError)
    ctx.finalizeModelOperationDelivery()
    const terminal = await ctx.whenModelOperationFinalized()
    expect(terminal.dispatches.find((entry) => entry.handle === dispatch)?.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: "response.failure-supersession",
        data: {
          supersededError: expect.objectContaining({ message: "upstream failure" }),
          supersededSource: "upstream-transport",
          flushError: expect.objectContaining({ message: "flush failure" }),
        },
      }),
    )
  })

  test("generation candidate metadata persists recoveryReason in the canonical snapshot", () => {
    const { ctx } = makeContext()
    const candidate = ctx.beginGenerationCandidate({ role: "recovery", metadata: { recoveryReason: "stream-error-before-content" } })

    expect(ctx.modelOperationSnapshot.candidates).toContainEqual(
      expect.objectContaining({ handle: candidate, role: "recovery", metadata: { recoveryReason: "stream-error-before-content" } }),
    )
  })

  test("markGenerationDispatchSynthetic aligns the transient and canonical upstream-request producers", () => {
    const { ctx } = makeContext()
    const candidate = ctx.beginGenerationCandidate({ role: "continuation" })
    const dispatch = ctx.beginGenerationDispatch({ candidate })
    const wireReq = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "continue" }],
      payload: { model: "claude-sonnet-4", messages: [{ role: "user", content: "continue" }] },
      headers: { "anthropic-version": "2023-06-01" },
      format: "anthropic-messages" as const,
    }
    ctx.setGenerationDispatchWireRequest(dispatch, wireReq)

    ctx.markGenerationDispatchSynthetic(dispatch, "continuation")

    expect(ctx.toHistoryEntry().attempts?.[0]?.upstreamRequest?.synthetic).toBe("continuation")
    expect(ctx.modelOperationSnapshot.dispatches[0]?.upstreamRequest?.synthetic).toBe("continuation")
  })

  test("setAttemptError stores error and calculates durationMs", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})

    const apiError: ApiError = {
      type: "server_error",
      status: 500,
      raw: new Error("test"),
      message: "Server error",
    }
    ctx.setAttemptError(apiError)

    expect(ctx.currentAttempt!.error).toBe(apiError)
    expect(ctx.currentAttempt!.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("toHistoryEntry projects a top-level failureReason for failed entries (from outboundResponse.error)", () => {
    const { ctx } = makeContext()
    ctx.fail("claude-opus-4.8", new Error("upstream blew up"))
    const entry = ctx.toHistoryEntry()
    expect(entry.state).toBe("failed")
    expect(entry._index?.derived?.failureReason).toBe("upstream blew up")
  })

  test("toHistoryEntry surfaces a top-level failureReason for aborted entries", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    ctx.setAttemptError({ type: "network_error", status: 0, raw: new Error("RST"), message: "connection reset" })
    ctx.abort("claude-opus-4.8") // abort() sets _response.error = "client disconnected"
    const entry = ctx.toHistoryEntry()
    expect(entry.state).toBe("aborted")
    expect(entry._index?.derived?.failureReason).toBe("client disconnected")
  })

  test("toHistoryEntry leaves failureReason absent for successful entries", () => {
    const { ctx } = makeContext()
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null, stop_reason: "end_turn" })
    expect(ctx.toHistoryEntry()._index?.derived?.failureReason).toBeUndefined()
  })

  test("setOutboundResponseTrailers records the h2 trailers leg on the entry", () => {
    const { ctx } = makeContext()
    ctx.setOutboundResponseTrailers({ "x-upstream-status": "ok", "grpc-status": "0" })
    ctx.beginAttempt({})
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null, stop_reason: "end_turn" })
    expect(ctx.toHistoryEntry().attempts?.at(-1)?.upstreamResponse?.trailers).toEqual({ "x-upstream-status": "ok", "grpc-status": "0" })
  })

  test("setAttemptTransport updates current and effective transport", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})

    expect(ctx.transport).toBe("http")

    ctx.setAttemptTransport("upstream-ws")

    expect(ctx.currentAttempt!.transport).toBe("upstream-ws")
    expect(ctx.transport).toBe("upstream-ws")
  })
})

// ─── Completion ───

describe("createRequestContext - completion", () => {
  test("complete() stores response and fires completed event with entry", () => {
    const { ctx, events } = makeContext()
    ctx.beginAttempt({})

    const response = {
      success: true,
      model: "claude-sonnet-4",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: "Hello!",
    }
    ctx.complete(response)

    expect(ctx.state).toBe("completed")
    expect(ctx.response).toEqual(response)
    expect(ctx.endTime).not.toBeNull()

    const lastCall = events.at(-1)!
    expect(lastCall.kind).toBe("request.completed")
    if (lastCall.kind === "request.completed") {
      expect(lastCall.entry).toBeDefined()
      expect(lastCall.entry.id).toBe(ctx.id)
      expect(lastCall.entry.startedAt).toBe(ctx.startTime)
      expect(lastCall.entry.endedAt).toBe(ctx.endTime!)
    }
  })

  test("fail() stores error response and fires failed event", () => {
    const { ctx, events } = makeContext()
    ctx.beginAttempt({})

    ctx.fail("claude-sonnet-4", new Error("Something broke"))

    expect(ctx.state).toBe("failed")
    expect(ctx.response!.success).toBe(false)
    expect(ctx.response!.error).toBe("Something broke")
    expect(ctx.endTime).not.toBeNull()

    const lastCall = events.at(-1)!
    expect(lastCall.kind).toBe("request.failed")
    if (lastCall.kind === "request.failed") {
      expect(lastCall.entry).toBeDefined()
    }
  })
})

// ─── Data setters ───

describe("createRequestContext - data setters", () => {
  test("addQueueWaitMs accumulates", () => {
    const { ctx } = makeContext()
    ctx.addQueueWaitMs(100)
    ctx.addQueueWaitMs(50)
    expect(ctx.queueWaitMs).toBe(150)
  })

  test("setOriginalRequest stores the request", () => {
    const { ctx } = makeContext()
    const req = {
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      payload: {},
    }
    ctx.setOriginalRequest(req)
    expect(ctx.originalRequest).toBe(req)
  })

  test("setPipelineInfo stores the pipeline info", () => {
    const { ctx } = makeContext()
    const pipeInfo = {
      messageMapping: [0],
    }
    ctx.setPipelineInfo(pipeInfo)
    expect(ctx.pipelineInfo).toEqual(pipeInfo)
  })

  test("addWarningMessage deduplicates", () => {
    const { ctx } = makeContext()
    const warning = {
      code: "cc_to_responses_dropped_params",
      message: "Dropped unsupported params: stop, seed",
    }

    ctx.addWarningMessage(warning)
    ctx.addWarningMessage(warning)

    expect(ctx.warningMessages).toEqual([warning])
  })
})

// ─── toHistoryEntry ───

describe("createRequestContext - toHistoryEntry", () => {
  test("serializes core fields", () => {
    const { ctx } = makeContext({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      payload: {},
    })
    ctx.beginAttempt({})
    ctx.complete({
      success: true,
      model: "claude-sonnet-4",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: "Hello",
    })

    const entry = ctx.toHistoryEntry()
    expect(entry.id).toBe(ctx.id)
    expect(entry.endpoint).toBe("anthropic-messages")
    expect(entry.clientRequest?.model).toBe("claude-sonnet-4")
    expect(entry.state).toBe("completed")
    expect(entry.active).toBe(false)
    expect(entry._index?.derived?.attemptCount).toBe(1)
    expect(entry.queueWaitMs).toBe(0)
    expect(entry.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
  })

  test("setRouteInfo projects routing observability into model{} (RFC §10 / T1.6)", () => {
    const { ctx } = makeContext({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "claude-opus-4.8", messages: [{ role: "user", content: "hi" }], stream: false, payload: {} })
    ctx.setResolvedModel({ resolved: "claude-opus-4.8" })
    // Direct anthropic leg: no client suffix, outbound /v1/messages, not translated.
    ctx.setRouteInfo?.({ outboundEndpoint: "/v1/messages", translated: false })
    ctx.beginAttempt({})
    ctx.complete({ success: true, model: "claude-opus-4.8", usage: { input_tokens: 1, output_tokens: 1 }, content: null, stop_reason: "end_turn" })

    const entry = ctx.toHistoryEntry()
    expect(entry.model?.outboundEndpoint).toBe("/v1/messages")
    expect(entry.model?.translated).toBe(false)
    // routeOverride omitted when the client typed no suffix.
    expect(entry.model?.routeOverride).toBeUndefined()
    // Existing fields untouched (zero regression).
    expect(entry.model?.resolved).toBe("claude-opus-4.8")
  })

  test("setRouteInfo records an explicit @messages pin + a translate leg label", () => {
    const { ctx } = makeContext({ endpoint: "anthropic-messages" })
    ctx.setOriginalRequest({ model: "claude-opus-4.8@messages", messages: [{ role: "user", content: "hi" }], stream: false, payload: {} })
    ctx.setResolvedModel({ resolved: "claude-opus-4.8" })
    ctx.setRouteInfo?.({ routeOverride: "messages", outboundEndpoint: "/v1/messages", translated: false })
    ctx.beginAttempt({})
    ctx.complete({ success: true, model: "claude-opus-4.8", usage: { input_tokens: 1, output_tokens: 1 }, content: null, stop_reason: "end_turn" })

    expect(ctx.toHistoryEntry().model?.routeOverride).toBe("messages")
  })

  test("synthesizes a failed non-final attempt's response carrying the upstream error rawBody (gap H)", () => {
    const B0 = '{"error":{"message":"attempt-0 upstream 500","type":"server_error"}}'
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "opus", messages: [{ role: "user", content: "hi" }], stream: false, payload: { model: "opus" } })

    // Attempt 0 fails with an upstream HTTP 500 carrying body B0 (no attempt.response set).
    ctx.beginAttempt({})
    ctx.setAttemptError({ type: "server_error", status: 500, message: "HTTP 500", raw: new HTTPError("HTTP 500", 500, B0) })

    // Attempt 1 succeeds; the request completes.
    ctx.beginAttempt({ strategy: "server-error-retry" })
    ctx.complete({ success: true, model: "opus", usage: { input_tokens: 5, output_tokens: 3 }, content: "ok" })

    const entry = ctx.toHistoryEntry()
    expect(entry.state).toBe("completed")
    // Terminal (final attempt) upstreamResponse is the SUCCESSFUL leg, not the failure.
    expect(entry.attempts?.at(-1)?.upstreamResponse?.success).toBe(true)
    // The failed attempt[0] carries a synthesized upstreamResponse whose rawBody is the error body,
    // so the downstream serialize path persists it (gap H evidence).
    expect(entry.attempts![0].upstreamResponse?.rawBody).toBe(B0)
    expect(entry.attempts![0].upstreamResponse?.success).toBe(false)
    expect(entry.attempts![0].upstreamResponse?.status).toBe(500)
    // The attempt error summary string is still present.
    expect(entry.attempts![0].error).toBe("HTTP 500")
  })

  test("serializes lifecycle activity fields", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      payload: {},
    })
    ctx.beginAttempt({ strategy: "network-retry" })
    ctx.addQueueWaitMs(250)
    ctx.transition("streaming")
    ctx.complete({
      success: true,
      model: "claude-sonnet-4",
      usage: { input_tokens: 12, output_tokens: 34 },
      content: "Hello",
    })

    const entry = ctx.toHistoryEntry()
    expect(entry.state).toBe("completed")
    expect(entry.active).toBe(false)
    expect(entry.queueWaitMs).toBe(250)
    expect(entry._index?.derived?.attemptCount).toBe(1)
    expect(entry._index?.derived?.currentStrategy).toBe("network-retry")
    expect(typeof entry.lastUpdatedAt).toBe("number")
    expect(entry.lastUpdatedAt).toBeGreaterThanOrEqual(entry.startedAt)
  })

  test("includes truncation from last attempt that had one", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })

    const truncation = {
      wasTruncated: true,
      originalTokens: 10000,
      compactedTokens: 5000,
      removedMessageCount: 3,
      processingTimeMs: 50,
    }
    ctx.beginAttempt({})
    ctx.beginAttempt({ strategy: "auto-truncate", truncation })
    // Truncation is aggregated into the attempt's effectiveSource.pipeline, which the
    // producer only builds when the attempt has an effectiveRequest — so set one.
    ctx.setAttemptEffectiveRequest({ model: "m", resolvedModel: undefined, messages: [], payload: {}, format: "anthropic-messages" })
    ctx.complete({
      success: true,
      model: "m",
      usage: { input_tokens: 50, output_tokens: 25 },
      content: "ok",
    })

    const entry = ctx.toHistoryEntry()
    // Truncation now lives on the last attempt's effectiveSource.pipeline (RFC §4).
    expect(entry.attempts?.at(-1)?.effectiveSource?.pipeline?.truncation).toEqual(truncation)
  })

  test("includes attempts summary when >1 attempt", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.beginAttempt({})
    ctx.beginAttempt({ strategy: "auto-truncate" })
    ctx.complete({
      success: true,
      model: "m",
      usage: { input_tokens: 50, output_tokens: 25 },
      content: "ok",
    })

    const entry = ctx.toHistoryEntry()
    expect(entry.attempts).toHaveLength(2)
    expect(entry.attempts![1].strategy).toBe("auto-truncate")
  })

  test("includes pipelineInfo when set", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.setPipelineInfo({
      messageMapping: [0],
    })
    ctx.beginAttempt({})
    ctx.complete({
      success: true,
      model: "m",
      usage: { input_tokens: 50, output_tokens: 25 },
      content: "ok",
    })

    const entry = ctx.toHistoryEntry()
    expect(entry.pipelineInfo).toBeDefined()
    expect(entry.pipelineInfo!.messageMapping).toEqual([0])
  })

  test("extracts max_tokens, temperature, thinking from payload", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      payload: {
        model: "claude-sonnet-4",
        max_tokens: 4096,
        temperature: 0.7,
        thinking: { type: "enabled", budget_tokens: 10000 },
        messages: [{ role: "user", content: "hi" }],
      },
    })
    ctx.beginAttempt({})
    ctx.complete({
      success: true,
      model: "claude-sonnet-4",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: "ok",
    })

    const entry = ctx.toHistoryEntry()
    expect(entry.clientRequest?.max_tokens).toBe(4096)
    expect(entry.clientRequest?.temperature).toBe(0.7)
    expect(entry.clientRequest?.thinking).toEqual({ type: "enabled", budget_tokens: 10000 })
  })

  test("omits max_tokens/temperature/thinking when not in payload", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: { model: "m", messages: [] } })
    ctx.beginAttempt({})
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 10, output_tokens: 5 }, content: null })

    const entry = ctx.toHistoryEntry()
    expect(entry.clientRequest?.max_tokens).toBeUndefined()
    expect(entry.clientRequest?.temperature).toBeUndefined()
    expect(entry.clientRequest?.thinking).toBeUndefined()
  })

  test("includes effectiveRequest from final attempt", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true, payload: {} })
    ctx.beginAttempt({})
    ctx.setAttemptEffectiveRequest({
      model: "claude-sonnet-4-20250514",
      resolvedModel: undefined,
      messages: [{ role: "user", content: "truncated" }],
      payload: { model: "claude-sonnet-4-20250514", messages: [{ role: "user", content: "truncated" }], system: "sys" },
      format: "anthropic-messages",
    })
    ctx.complete({
      success: true,
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: "ok",
    })

    const entry = ctx.toHistoryEntry()
    const effectiveSource = entry.attempts?.at(-1)?.effectiveSource
    expect(effectiveSource).toBeDefined()
    expect(effectiveSource!.model).toBe("claude-sonnet-4-20250514")
    expect(effectiveSource!.format).toBe("anthropic-messages")
    expect(effectiveSource!.messageCount).toBe(1)
    expect(effectiveSource!.messages).toHaveLength(1)
    expect(effectiveSource!.system).toBe("sys")
  })

  test("includes wireRequest from final attempt separately from effectiveRequest", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true, payload: {} })
    ctx.beginAttempt({})
    ctx.setAttemptEffectiveRequest({
      model: "claude-opus-4-6",
      resolvedModel: undefined,
      messages: [{ role: "user", content: "logical" }],
      payload: { model: "claude-opus-4-6", messages: [{ role: "user", content: "logical" }] },
      format: "anthropic-messages",
    })
    ctx.setAttemptWireRequest({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "logical" }],
      payload: {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "logical" }],
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      },
      headers: {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "context-management-2025-06-27,advanced-tool-use-2025-11-20",
      },
      format: "anthropic-messages",
    })
    ctx.complete({
      success: true,
      model: "claude-opus-4-6",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: "ok",
    })

    const entry = ctx.toHistoryEntry()
    const finalAttempt = entry.attempts?.at(-1)
    expect(finalAttempt?.effectiveSource).toBeDefined()
    expect(finalAttempt?.effectiveSource!.body).toEqual({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "logical" }],
    })
    expect(finalAttempt?.upstreamRequest).toBeDefined()
    expect(finalAttempt?.upstreamRequest!.body).toEqual({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "logical" }],
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    })
    // RFC Phase 2: upstreamRequest.headers is written by the driver during the
    // exchange (from wire.headers), no longer migrated from wireRequest at finalize —
    // so toHistoryEntry() alone (no driver run) does not populate it here.
  })

  test("effectiveSource is undefined when no attempt set an effectiveRequest", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.beginAttempt({})
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 10, output_tokens: 5 }, content: null })

    const entry = ctx.toHistoryEntry()
    expect(entry.attempts?.at(-1)?.effectiveSource).toBeUndefined()
  })

  test("always includes attempts array even for single attempt", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.beginAttempt({})
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 10, output_tokens: 5 }, content: null })

    const entry = ctx.toHistoryEntry()
    expect(entry.attempts).toBeDefined()
    expect(entry.attempts).toHaveLength(1)
    expect(entry.attempts![0].index).toBe(0)
    expect(entry.attempts![0].strategy).toBeUndefined()
  })

  test("includes transport in entry and attempt summary", () => {
    const { ctx } = makeContext({ endpoint: "openai-responses" })
    ctx.setOriginalRequest({ model: "gpt-5.2", messages: [], stream: true, payload: {} })
    ctx.beginAttempt({})
    ctx.setAttemptTransport("upstream-ws-fallback")
    ctx.complete({ success: true, model: "gpt-5.2", usage: { input_tokens: 10, output_tokens: 5 }, content: null })

    const entry = ctx.toHistoryEntry()
    expect(entry.transport).toBe("upstream-ws-fallback")
    expect(entry.attempts![0].transport).toBe("upstream-ws-fallback")
  })

  test("attempts is undefined when no attempt was started", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 10, output_tokens: 5 }, content: null })

    const entry = ctx.toHistoryEntry()
    expect(entry.attempts).toBeUndefined()
  })

  test("attempt summary includes sanitization and effectiveMessageCount", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.beginAttempt({})
    ctx.setAttemptSanitization({
      totalBlocksRemoved: 2,
      orphanedToolUseCount: 1,
      orphanedToolResultCount: 0,
      fixedNameCount: 0,
      emptyTextBlocksRemoved: 1,
      emptyThinkingBlocksRemoved: 0,
      systemReminderRemovals: 0,
    })
    ctx.setAttemptEffectiveRequest({
      model: "m",
      resolvedModel: undefined,
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
      payload: {},
      format: "anthropic-messages",
    })
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 10, output_tokens: 5 }, content: null })

    const entry = ctx.toHistoryEntry()
    expect(entry.attempts![0].effectiveSource?.pipeline?.sanitization?.[0]?.totalBlocksRemoved).toBe(2)
    expect(entry.attempts![0].effectiveSource?.messageCount).toBe(2)
  })

  test("includes sseEvents and per-attempt request/response headers in entry", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.setSseEvents([{ offsetMs: 0, type: "message_start", raw: "{}" }])
    ctx.beginAttempt({})
    // Per-attempt legs: request headers ride the wire request (→ upstreamRequest.headers),
    // response headers are captured per attempt (→ upstreamResponse.headers). The unified
    // upstream frames (top-level _sseEvents) land on the final attempt's upstreamResponse.
    ctx.setAttemptWireRequest({ model: "m", messages: [], payload: {}, headers: { "x-req": "1" }, format: "anthropic-messages" })
    ctx.setAttemptResponseHeaders({ "x-res": "2" })
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 10, output_tokens: 5 }, content: null })

    const finalAttempt = ctx.toHistoryEntry().attempts?.at(-1)
    expect(finalAttempt?.upstreamResponse?.sseEvents).toHaveLength(1)
    expect(finalAttempt?.upstreamRequest?.headers).toEqual({ "x-req": "1" })
    expect(finalAttempt?.upstreamResponse?.headers).toEqual({ "x-res": "2" })
  })

  test("includes warningMessages in entry", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: false, payload: {} })
    ctx.addWarningMessage({
      code: "cc_to_responses_dropped_params",
      message: "Dropped unsupported params: stop",
    })
    ctx.beginAttempt({})
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null })

    const entry = ctx.toHistoryEntry()
    expect(entry.warningMessages).toEqual([
      {
        code: "cc_to_responses_dropped_params",
        message: "Dropped unsupported params: stop",
      },
    ])
  })
})

// ─── Settled guard (idempotent completion) ───

describe("createRequestContext - settled guard", () => {
  test("settled becomes true after complete()", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    expect(ctx.settled).toBe(false)
    ctx.complete({
      success: true,
      model: "m",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: "ok",
    })
    expect(ctx.settled).toBe(true)
  })

  test("settled becomes true after fail()", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    expect(ctx.settled).toBe(false)
    ctx.fail("m", new Error("err"))
    expect(ctx.settled).toBe(true)
  })

  test("fail() with HTTPError preserves status and responseText", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    const httpError = new HTTPError("Token limit", 400, '{"error":"prompt too long"}', "claude-sonnet-4")
    ctx.fail("claude-sonnet-4", httpError)

    expect(ctx.response!.status).toBe(400)
    expect(ctx.response!.responseText).toBe('{"error":"prompt too long"}')
    expect(ctx.response!.error).toContain("Token limit")
    expect(ctx.response!.success).toBe(false)
  })

  test("fail() with generic Error has no status or responseText", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    ctx.fail("m", new Error("connection reset"))

    expect(ctx.response!.status).toBeUndefined()
    expect(ctx.response!.responseText).toBeUndefined()
    expect(ctx.response!.error).toBe("connection reset")
  })

  test("double complete() only fires event once", () => {
    const { ctx, events } = makeContext()
    ctx.beginAttempt({})

    const response = {
      success: true,
      model: "claude-sonnet-4",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: "Hello!",
    }
    ctx.complete(response)
    const eventsAfterFirst = events.length

    ctx.complete(response) // second call — should be no-op
    expect(events.length).toBe(eventsAfterFirst)
    expect(ctx.state).toBe("completed")
  })

  test("double fail() only fires event once", () => {
    const { ctx, events } = makeContext()
    ctx.beginAttempt({})

    ctx.fail("claude-sonnet-4", new Error("err1"))
    const eventsAfterFirst = events.length

    ctx.fail("claude-sonnet-4", new Error("err2")) // second call — should be no-op
    expect(events.length).toBe(eventsAfterFirst)
    expect(ctx.state).toBe("failed")
  })

  test("fail() after complete() is no-op", () => {
    const { ctx, events } = makeContext()
    ctx.beginAttempt({})

    ctx.complete({
      success: true,
      model: "m",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: "ok",
    })
    const eventsAfterComplete = events.length

    ctx.fail("m", new Error("too late"))
    expect(events.length).toBe(eventsAfterComplete)
    expect(ctx.state).toBe("completed")
  })

  test("complete() after fail() is no-op", () => {
    const { ctx, events } = makeContext()
    ctx.beginAttempt({})

    ctx.fail("m", new Error("failed"))
    const eventsAfterFail = events.length

    ctx.complete({
      success: true,
      model: "m",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: "ok",
    })
    expect(events.length).toBe(eventsAfterFail)
    expect(ctx.state).toBe("failed")
  })
})

// ─── P2.5: producer alignment — fail()/abort() populate final attempt response ───
//
// `complete()` writes the settled verdict onto the final attempt via
// `setAttemptResponse`. Before P2.5, `fail()`/`abort()` wrote only the top-level
// `_response` — so the live object's `attempts[last].response` was null and the
// per-attempt `upstreamResponse` leg had to be SYNTHESIZED from the attempt's
// HTTPError body (thinner than the real verdict: no model / partial usage /
// stop_reason / partial content). These tests pin that fail()/abort() now land
// the FULL verdict on the final attempt (symmetric with complete), so the
// `a.response ?? synthesizeAttemptErrorResponse(a)` fallback short-circuits to
// the rich real `_response` rather than the thin synth.
describe("createRequestContext - P2.5 producer alignment (fail/abort → final attempt)", () => {
  test("fail() with HTTPError lands full verdict on final attempt.response + upstreamResponse leg", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    ctx.fail("claude-sonnet-4-5", new HTTPError("x", 400, "body"))

    const entry = ctx.toHistoryEntry()
    const last = entry.attempts?.at(-1)

    // The per-attempt upstreamResponse leg carries the settled verdict (not undefined).
    expect(last?.upstreamResponse).toBeDefined()
    expect(last?.upstreamResponse?.success).toBe(false)
    // getErrorMessage formats an HTTPError as "HTTP <status>: <body>"; the formatted
    // request-outcome error lives on the entry-level failureReason projection (the
    // upstreamResponse leg carries no error field).
    expect(entry._index?.derived?.failureReason).toBe("HTTP 400: body")
    expect(last?.upstreamResponse?.status).toBe(400)
    expect(last?.upstreamResponse?.rawBody).toBe("body")
    // Model normalized (claude-sonnet-4-5 → claude-sonnet-4.5).
    expect(last?.upstreamResponse?.model).toBe("claude-sonnet-4.5")

    // New client/upstream leg (RFC §S1) reflects the same verdict.
    expect(last?.upstreamResponse).toBeDefined()
    expect(last?.upstreamResponse?.success).toBe(false)
    expect(last?.upstreamResponse?.status).toBe(400)
    expect(last?.upstreamResponse?.rawBody).toBe("body")
    expect(last?.upstreamResponse?.model).toBe("claude-sonnet-4.5")
  })

  test("fail() with partial lands rich verdict — richer than the thin synth fallback", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    // HTTPError body means synthesizeAttemptErrorResponse WOULD produce a stage,
    // but a thin one (usage {0,0}, content null, no stop_reason). The real verdict
    // carries the partial usage/stop_reason/content — proving the `??` short-circuits
    // to the rich real `_response`, not the synth.
    ctx.fail(
      "claude-sonnet-4",
      new HTTPError("truncated", 200, "partial-body"),
      { usage: { input_tokens: 12, output_tokens: 7 }, stop_reason: "max_tokens", content: "half a tool_use" },
      {},
    )

    const last = ctx.toHistoryEntry().attempts?.at(-1)
    expect(last?.upstreamResponse?.usage).toEqual({ input_tokens: 12, output_tokens: 7 })
    expect(last?.upstreamResponse?.stopReason).toBe("max_tokens")
    expect(last?.upstreamResponse?.body).toBe("half a tool_use")
    // Distinguishes real verdict from synth (synth would be {0,0} / null / undefined).
    expect(last?.upstreamResponse?.usage).not.toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  test("fail() with upstreamSucceeded lands the HONEST success:true leg (no error)", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    ctx.fail("claude-sonnet-4", new Error("proxy rejected malformed tool_use"), undefined, { upstreamSucceeded: true })

    const entry = ctx.toHistoryEntry()
    const last = entry.attempts?.at(-1)
    expect(last?.upstreamResponse?.success).toBe(true)
    // The request verdict still lives at entry level (the failureReason projection), not
    // jammed into the honest success:true upstreamResponse leg (which carries no error field).
    expect(entry._index?.derived?.failureReason).toBe("proxy rejected malformed tool_use")
    expect(ctx.state).toBe("failed")
  })

  test("abort() lands the aborted verdict on the final attempt", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    ctx.abort("claude-sonnet-4-5", { usage: { input_tokens: 5, output_tokens: 3 }, stop_reason: "abort" })

    const entry = ctx.toHistoryEntry()
    const last = entry.attempts?.at(-1)
    expect(last?.upstreamResponse).toBeDefined()
    expect(last?.upstreamResponse?.success).toBe(false)
    expect(entry._index?.derived?.failureReason).toBe("client disconnected")
    expect(last?.upstreamResponse?.model).toBe("claude-sonnet-4.5")
    expect(last?.upstreamResponse?.usage).toEqual({ input_tokens: 5, output_tokens: 3 })
    expect(last?.upstreamResponse?.stopReason).toBe("abort")
    expect(last?.upstreamResponse?.success).toBe(false)
    expect(last?.upstreamResponse?.model).toBe("claude-sonnet-4.5")
  })

  test("fail() does not re-write the final attempt when already settled", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    ctx.fail("claude-sonnet-4", new HTTPError("first", 400, "body-1"))
    ctx.fail("claude-sonnet-4", new HTTPError("second", 500, "body-2")) // no-op

    const last = ctx.toHistoryEntry().attempts?.at(-1)
    expect(last?.upstreamResponse?.status).toBe(400)
    expect(last?.upstreamResponse?.rawBody).toBe("body-1")
  })
})

// ─── setStreamTimeouts / mergedPipelineInfo (D2 diagnostics, Phase 4a) ───

describe("setStreamTimeouts merges into pipelineInfo without clobbering", () => {
  test("stream timeouts survive when setPipelineInfo is never called", () => {
    // The D2 core requirement: every request gets the diagnostic field, even
    // when no sanitization/truncation ever triggers setPipelineInfo.
    const { ctx } = makeContext()
    ctx.setStreamTimeouts({ streamIdleTimeoutMs: 600_000 })
    expect(ctx.pipelineInfo?.streamIdleTimeoutMs).toBe(600_000)
  })

  test("setStreamTimeouts before setPipelineInfo: both survive", () => {
    const { ctx } = makeContext()
    ctx.setStreamTimeouts({ streamIdleTimeoutMs: 600_000 })
    ctx.setPipelineInfo({ sanitization: [] })
    expect(ctx.pipelineInfo?.streamIdleTimeoutMs).toBe(600_000)
    expect(ctx.pipelineInfo?.sanitization).toEqual([])
  })

  test("setStreamTimeouts after setPipelineInfo: full-replace does not clobber it", () => {
    const { ctx } = makeContext()
    ctx.setPipelineInfo({ sanitization: [] })
    ctx.setStreamTimeouts({ streamIdleTimeoutMs: 600_000 })
    expect(ctx.pipelineInfo?.streamIdleTimeoutMs).toBe(600_000)
    expect(ctx.pipelineInfo?.sanitization).toEqual([])
  })

  test("merge semantics: two setStreamTimeouts calls accumulate", () => {
    const { ctx } = makeContext()
    ctx.setStreamTimeouts({ streamIdleTimeoutMs: 600_000 })
    ctx.setStreamTimeouts({ responseHeaderTimeoutMs: 420_000 })
    expect(ctx.pipelineInfo?.streamIdleTimeoutMs).toBe(600_000)
    expect(ctx.pipelineInfo?.responseHeaderTimeoutMs).toBe(420_000)
  })

  test("toHistoryEntry (onTerminal projection) carries the merged stream timeouts", () => {
    const { ctx } = makeContext()
    ctx.setStreamTimeouts({ streamIdleTimeoutMs: 600_000 })
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: null, stop_reason: "end_turn" })
    expect(ctx.toHistoryEntry().pipelineInfo?.streamIdleTimeoutMs).toBe(600_000)
  })
})
