/**
 * Component tests for RequestContext state machine.
 *
 * Tests: createRequestContext, state transitions, attempts, events
 */

import { describe, expect, mock, test } from "bun:test"

import type { ApiError } from "~/lib/error"
import type { EndpointType } from "~/lib/history/store"

import { createRequestContext } from "~/lib/context/request"
import { HTTPError } from "~/lib/error"

function makeContext(overrides?: { endpoint?: EndpointType; tuiLogId?: string }) {
  const onEvent = mock(() => {})
  const ctx = createRequestContext({
    endpoint: overrides?.endpoint ?? "anthropic-messages",
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
    const { ctx } = makeContext({ endpoint: "openai-chat-completions" })
    expect(ctx.endpoint).toBe("openai-chat-completions")
  })

  test("stores tuiLogId", () => {
    const { ctx } = makeContext({ tuiLogId: "my-tracking" })
    expect(ctx.tuiLogId).toBe("my-tracking")
  })

  test("initializes with null data fields and empty attempts", () => {
    const { ctx } = makeContext()
    expect(ctx.originalRequest).toBeNull()
    expect(ctx.response).toBeNull()
    expect(ctx.pipelineInfo).toBeNull()
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
    ctx.setAttemptSanitization({
      totalBlocksRemoved: 3,
      systemReminderRemovals: 1,
      orphanedToolUseCount: 0,
      orphanedToolResultCount: 0,
      fixedNameCount: 0,
      emptyTextBlocksRemoved: 0,
    })

    expect(ctx.currentAttempt!.sanitization).toEqual({
      totalBlocksRemoved: 3,
      systemReminderRemovals: 1,
      orphanedToolUseCount: 0,
      orphanedToolResultCount: 0,
      fixedNameCount: 0,
      emptyTextBlocksRemoved: 0,
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

  test("setPipelineInfo stores and emits", () => {
    const { ctx, onEvent } = makeContext()
    const pipeInfo = {
      messageMapping: [0],
    }
    ctx.setPipelineInfo(pipeInfo)
    expect(ctx.pipelineInfo).toEqual(pipeInfo)
    expect((onEvent.mock.calls.at(-1) as any)![0].field).toBe("pipelineInfo")
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
    ctx.complete({ success: true, model: "claude-sonnet-4", usage: { input_tokens: 10, output_tokens: 5 }, content: "ok" })

    const entry = ctx.toHistoryEntry()
    expect(entry.request.max_tokens).toBe(4096)
    expect(entry.request.temperature).toBe(0.7)
    expect(entry.request.thinking).toEqual({ type: "enabled", budget_tokens: 10000 })
  })

  test("omits max_tokens/temperature/thinking when not in payload", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: { model: "m", messages: [] } })
    ctx.beginAttempt({})
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 10, output_tokens: 5 }, content: null })

    const entry = ctx.toHistoryEntry()
    expect(entry.request.max_tokens).toBeUndefined()
    expect(entry.request.temperature).toBeUndefined()
    expect(entry.request.thinking).toBeUndefined()
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
    ctx.complete({ success: true, model: "claude-sonnet-4-20250514", usage: { input_tokens: 10, output_tokens: 5 }, content: "ok" })

    const entry = ctx.toHistoryEntry()
    expect(entry.effectiveRequest).toBeDefined()
    expect(entry.effectiveRequest!.model).toBe("claude-sonnet-4-20250514")
    expect(entry.effectiveRequest!.format).toBe("anthropic-messages")
    expect(entry.effectiveRequest!.messageCount).toBe(1)
    expect(entry.effectiveRequest!.messages).toHaveLength(1)
    expect(entry.effectiveRequest!.system).toBe("sys")
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
    ctx.complete({ success: true, model: "claude-opus-4-6", usage: { input_tokens: 10, output_tokens: 5 }, content: "ok" })

    const entry = ctx.toHistoryEntry()
    expect(entry.effectiveRequest).toBeDefined()
    expect(entry.effectiveRequest!.payload).toEqual({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "logical" }],
    })
    expect(entry.wireRequest).toBeDefined()
    expect(entry.wireRequest!.payload).toEqual({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "logical" }],
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    })
    expect(entry.wireRequest!.headers).toEqual({
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "context-management-2025-06-27,advanced-tool-use-2025-11-20",
    })
  })

  test("effectiveRequest is undefined when no attempt set it", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.beginAttempt({})
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 10, output_tokens: 5 }, content: null })

    const entry = ctx.toHistoryEntry()
    expect(entry.effectiveRequest).toBeUndefined()
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
      systemReminderRemovals: 0,
    })
    ctx.setAttemptEffectiveRequest({
      model: "m",
      resolvedModel: undefined,
      messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }],
      payload: {},
      format: "anthropic-messages",
    })
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 10, output_tokens: 5 }, content: null })

    const entry = ctx.toHistoryEntry()
    expect(entry.attempts![0].sanitization!.totalBlocksRemoved).toBe(2)
    expect(entry.attempts![0].effectiveMessageCount).toBe(2)
  })

  test("includes sseEvents and httpHeaders in entry", () => {
    const { ctx } = makeContext()
    ctx.setOriginalRequest({ model: "m", messages: [], stream: true, payload: {} })
    ctx.setSseEvents([{ offsetMs: 0, type: "message_start", data: {} }])
    ctx.setHttpHeaders({ request: { "x-req": "1" }, response: { "x-res": "2" } })
    ctx.beginAttempt({})
    ctx.complete({ success: true, model: "m", usage: { input_tokens: 10, output_tokens: 5 }, content: null })

    const entry = ctx.toHistoryEntry()
    expect(entry.sseEvents).toHaveLength(1)
    expect(entry.httpHeaders).toEqual({ request: { "x-req": "1" }, response: { "x-res": "2" } })
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
    const { ctx, onEvent } = makeContext()
    ctx.beginAttempt({})

    const response = {
      success: true,
      model: "claude-sonnet-4",
      usage: { input_tokens: 100, output_tokens: 50 },
      content: "Hello!",
    }
    ctx.complete(response)
    const eventsAfterFirst = onEvent.mock.calls.length

    ctx.complete(response) // second call — should be no-op
    expect(onEvent.mock.calls.length).toBe(eventsAfterFirst)
    expect(ctx.state).toBe("completed")
  })

  test("double fail() only fires event once", () => {
    const { ctx, onEvent } = makeContext()
    ctx.beginAttempt({})

    ctx.fail("claude-sonnet-4", new Error("err1"))
    const eventsAfterFirst = onEvent.mock.calls.length

    ctx.fail("claude-sonnet-4", new Error("err2")) // second call — should be no-op
    expect(onEvent.mock.calls.length).toBe(eventsAfterFirst)
    expect(ctx.state).toBe("failed")
  })

  test("fail() after complete() is no-op", () => {
    const { ctx, onEvent } = makeContext()
    ctx.beginAttempt({})

    ctx.complete({
      success: true,
      model: "m",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: "ok",
    })
    const eventsAfterComplete = onEvent.mock.calls.length

    ctx.fail("m", new Error("too late"))
    expect(onEvent.mock.calls.length).toBe(eventsAfterComplete)
    expect(ctx.state).toBe("completed")
  })

  test("complete() after fail() is no-op", () => {
    const { ctx, onEvent } = makeContext()
    ctx.beginAttempt({})

    ctx.fail("m", new Error("failed"))
    const eventsAfterFail = onEvent.mock.calls.length

    ctx.complete({
      success: true,
      model: "m",
      usage: { input_tokens: 1, output_tokens: 1 },
      content: "ok",
    })
    expect(onEvent.mock.calls.length).toBe(eventsAfterFail)
    expect(ctx.state).toBe("failed")
  })
})
