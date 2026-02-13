/**
 * Component tests for RequestContext state machine.
 *
 * Tests: createRequestContext, state transitions, attempts, events
 */

import { describe, expect, mock, test } from "bun:test"

import type { ApiError } from "~/lib/error"

import { createRequestContext } from "~/lib/context/request"

function makeContext(overrides?: { endpoint?: "anthropic" | "openai"; tuiLogId?: string }) {
  const onEvent = mock(() => {})
  const ctx = createRequestContext({
    endpoint: overrides?.endpoint ?? "anthropic",
    tuiLogId: overrides?.tuiLogId ?? "track-1",
    onEvent,
  })
  return { ctx, onEvent }
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
    const { ctx } = makeContext({ endpoint: "openai" })
    expect(ctx.endpoint).toBe("openai")
  })

  test("stores tuiLogId", () => {
    const { ctx } = makeContext({ tuiLogId: "my-tracking" })
    expect(ctx.tuiLogId).toBe("my-tracking")
  })

  test("initializes with null data fields and empty attempts", () => {
    const { ctx } = makeContext()
    expect(ctx.originalRequest).toBeNull()
    expect(ctx.response).toBeNull()
    expect(ctx.translation).toBeNull()
    expect(ctx.rewrites).toBeNull()
    expect(ctx.attempts).toHaveLength(0)
    expect(ctx.currentAttempt).toBeNull()
    expect(ctx.queueWaitMs).toBe(0)
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
    ctx.transition("sanitizing")
    expect(ctx.state).toBe("sanitizing")

    ctx.transition("executing")
    expect(ctx.state).toBe("executing")
  })

  test("transition() fires state_changed event with previousState", () => {
    const { ctx, onEvent } = makeContext()
    ctx.transition("executing", { reason: "test" })

    const lastCall = (onEvent.mock.calls.at(-1) as any)![0]
    expect(lastCall.type).toBe("state_changed")
    expect(lastCall.previousState).toBe("pending")
    expect(lastCall.meta).toEqual({ reason: "test" })
    expect(lastCall.context).toBe(ctx)
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
    ctx.setAttemptSanitization({ removedCount: 3, systemReminderRemovals: 1 })

    expect(ctx.currentAttempt!.sanitization).toEqual({
      removedCount: 3,
      systemReminderRemovals: 1,
    })
  })

  test("setAttemptEffectiveRequest stores on currentAttempt", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})
    const effectiveReq = {
      model: "claude-sonnet-4",
      resolvedModel: undefined,
      messages: [{ role: "user", content: "hi" }],
      payload: {},
      format: "anthropic" as const,
    }
    ctx.setAttemptEffectiveRequest(effectiveReq)

    expect(ctx.currentAttempt!.effectiveRequest).toBe(effectiveReq)
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
})

// ─── Completion ───

describe("createRequestContext - completion", () => {
  test("complete() stores response and fires completed event with entry", () => {
    const { ctx, onEvent } = makeContext()
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

    const lastCall = (onEvent.mock.calls.at(-1) as any)![0]
    expect(lastCall.type).toBe("completed")
    expect(lastCall.entry).toBeDefined()
    expect(lastCall.entry!.id).toBe(ctx.id)
  })

  test("completeFromStream() builds response from accumulator data", () => {
    const { ctx } = makeContext()
    ctx.beginAttempt({})

    ctx.completeFromStream({
      model: "claude-sonnet-4",
      content: "Hello world",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      stopReason: "end_turn",
      contentBlocks: [{ type: "text", text: "Hello world" }],
    })

    expect(ctx.state).toBe("completed")
    expect(ctx.response!.success).toBe(true)
    expect(ctx.response!.model).toBe("claude-sonnet-4")
    expect(ctx.response!.stop_reason).toBe("end_turn")
  })

  test("fail() stores error response and fires failed event", () => {
    const { ctx, onEvent } = makeContext()
    ctx.beginAttempt({})

    ctx.fail("claude-sonnet-4", new Error("Something broke"))

    expect(ctx.state).toBe("failed")
    expect(ctx.response!.success).toBe(false)
    expect(ctx.response!.error).toBe("Something broke")

    const lastCall = (onEvent.mock.calls.at(-1) as any)![0]
    expect(lastCall.type).toBe("failed")
    expect(lastCall.entry).toBeDefined()
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

  test("setOriginalRequest stores and emits", () => {
    const { ctx, onEvent } = makeContext()
    const req = {
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      payload: {},
    }
    ctx.setOriginalRequest(req)
    expect(ctx.originalRequest).toBe(req)
    expect((onEvent.mock.calls.at(-1) as any)![0].field).toBe("originalRequest")
  })

  test("setTranslation stores and emits", () => {
    const { ctx, onEvent } = makeContext()
    ctx.setTranslation({ direction: "openai-to-anthropic" })
    expect(ctx.translation).toEqual({ direction: "openai-to-anthropic" })
    expect((onEvent.mock.calls.at(-1) as any)![0].field).toBe("translation")
  })

  test("setRewrites stores and emits", () => {
    const { ctx, onEvent } = makeContext()
    const rewrite = {
      originalMessages: [{ role: "user", content: "hi" }],
      rewrittenMessages: [{ role: "user", content: "hello" }],
      messageMapping: [0],
    }
    ctx.setRewrites(rewrite)
    expect(ctx.rewrites).toBe(rewrite)
    expect((onEvent.mock.calls.at(-1) as any)![0].field).toBe("rewrites")
  })
})

// ─── toHistoryEntry ───

describe("createRequestContext - toHistoryEntry", () => {
  test("serializes core fields", () => {
    const { ctx } = makeContext({ endpoint: "anthropic" })
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
    expect(entry.endpoint).toBe("anthropic")
    expect(entry.request.model).toBe("claude-sonnet-4")
    expect(entry.response!.success).toBe(true)
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
    ctx.complete({
      success: true,
      model: "m",
      usage: { input_tokens: 50, output_tokens: 25 },
      content: "ok",
    })

    const entry = ctx.toHistoryEntry()
    expect(entry.truncation).toEqual(truncation)
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

  test("includes rewrites when set", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.setRewrites({
      originalMessages: [{ role: "user", content: "hi" }],
      rewrittenMessages: [{ role: "user", content: "hello" }],
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
    expect(entry.rewrites).toBeDefined()
    expect(entry.rewrites!.messageMapping).toEqual([0])
  })
})
