/**
 * Integration tests for pipeline with real strategy.
 *
 * Tests pipeline + real classifyError + real createAutoTruncateStrategy
 * working together. Only mocks the network boundary (adapter.execute).
 */

import { afterEach, describe, expect, mock, test } from "bun:test"

import type { FormatAdapter, RetryStrategy, SanitizeResult } from "~/lib/request/pipeline"
import type { TruncateResult } from "~/lib/request/strategies/auto-truncate"

import { resetAllLimitsForTesting } from "~/lib/auto-truncate"
import { createRequestContextManager } from "~/lib/context/manager"
import { HTTPError } from "~/lib/error"
import { executeRequestPipeline } from "~/lib/request/pipeline"
import { createAutoTruncateStrategy } from "~/lib/request/strategies/auto-truncate"

import { mockModel } from "../helpers/factories"
import { createMockAdapter } from "../helpers/mock-adapter"

type TestPayload = { messages: Array<{ content: string }>; _size?: number }

afterEach(() => {
  resetAllLimitsForTesting()
})

function realAutoTruncateStrategy() {
  return createAutoTruncateStrategy<TestPayload>({
    truncate: async (payload, _model, _options): Promise<TruncateResult<TestPayload>> => {
      // Simple truncation: remove first message
      if (payload.messages.length <= 1) {
        return {
          wasTruncated: false,
          payload,
          removedMessageCount: 0,
          originalTokens: 100,
          compactedTokens: 100,
          processingTimeMs: 1,
        }
      }
      return {
        wasTruncated: true,
        payload: { messages: payload.messages.slice(1) },
        removedMessageCount: 1,
        originalTokens: payload.messages.length * 100,
        compactedTokens: (payload.messages.length - 1) * 100,
        processingTimeMs: 5,
      }
    },
    resanitize: (payload): SanitizeResult<TestPayload> => ({
      payload,
      blocksRemoved: 0,
      systemReminderRemovals: 0,
    }),
    isEnabled: () => true,
    label: "test-integration",
  })
}

describe("pipeline with auto-truncate strategy (integration)", () => {
  test("retries on 413 with truncated payload", async () => {
    let callCount = 0
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async (payload: TestPayload) => {
        callCount++
        if (callCount === 1) {
          throw new HTTPError("Too large", 413, "")
        }
        return { result: { success: true, messageCount: payload.messages.length }, queueWaitMs: 0 }
      }),
    })

    const result = await executeRequestPipeline({
      adapter,
      payload: {
        messages: [{ content: "msg 1" }, { content: "msg 2" }, { content: "msg 3" }],
      },
      originalPayload: {
        messages: [{ content: "msg 1" }, { content: "msg 2" }, { content: "msg 3" }],
      },
      strategies: [realAutoTruncateStrategy()],
      model: mockModel("gpt-4"),
    })

    expect(callCount).toBe(2)
    expect(result.totalRetries).toBe(1)
    expect((result.response as any).messageCount).toBe(2) // one message removed
  })

  test("retries on token_limit error with reduced payload", async () => {
    let callCount = 0
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async (_payload: TestPayload) => {
        callCount++
        if (callCount === 1) {
          throw new HTTPError(
            "Token limit",
            400,
            JSON.stringify({
              error: {
                code: "model_max_prompt_tokens_exceeded",
                message: "prompt token count of 135355 exceeds the limit of 128000",
              },
            }),
          )
        }
        return { result: { success: true }, queueWaitMs: 0 }
      }),
    })

    const result = await executeRequestPipeline({
      adapter,
      payload: { messages: [{ content: "a" }, { content: "b" }, { content: "c" }] },
      originalPayload: { messages: [{ content: "a" }, { content: "b" }, { content: "c" }] },
      strategies: [realAutoTruncateStrategy()],
      model: mockModel("gpt-4"),
    })

    expect(callCount).toBe(2)
    expect(result.totalRetries).toBe(1)
  })

  test("gives up after maxRetries exhausted", async () => {
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async () => {
        throw new HTTPError("Too large", 413, "")
      }),
    })

    await expect(
      executeRequestPipeline({
        adapter,
        payload: {
          messages: [{ content: "a" }, { content: "b" }, { content: "c" }, { content: "d" }, { content: "e" }],
        },
        originalPayload: {
          messages: [{ content: "a" }, { content: "b" }, { content: "c" }, { content: "d" }, { content: "e" }],
        },
        strategies: [realAutoTruncateStrategy()],
        model: mockModel("gpt-4"),
        maxRetries: 2,
      }),
    ).rejects.toThrow()

    // 1 initial + 2 retries = 3 calls
    expect(adapter.execute).toHaveBeenCalledTimes(3)
  })

  test("succeeds after truncation retry", async () => {
    let callCount = 0
    const adapter = createMockAdapter<TestPayload>({
      execute: mock(async (payload: TestPayload) => {
        callCount++
        // First 2 calls fail, third succeeds
        if (callCount <= 2) {
          throw new HTTPError("Too large", 413, "")
        }
        return { result: { done: true, remaining: payload.messages.length }, queueWaitMs: 5 }
      }),
    })

    const result = await executeRequestPipeline({
      adapter,
      payload: { messages: [{ content: "a" }, { content: "b" }, { content: "c" }, { content: "d" }] },
      originalPayload: { messages: [{ content: "a" }, { content: "b" }, { content: "c" }, { content: "d" }] },
      strategies: [realAutoTruncateStrategy()],
      model: mockModel("gpt-4"),
    })

    expect(callCount).toBe(3)
    expect(result.totalRetries).toBe(2)
    expect((result.response as any).done).toBe(true)
  })
})

// ─── Pipeline with Responses-format adapter ───

type ResponsesTestPayload = {
  model: string
  input: Array<{ type: string; content: string }>
  stream?: boolean
}

function createResponsesAdapter(
  executeFn?: (p: ResponsesTestPayload) => Promise<{ result: unknown; queueWaitMs: number }>,
): FormatAdapter<ResponsesTestPayload> {
  return {
    format: "openai-responses",
    sanitize: (p) => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0 }),
    execute:
      executeFn
      ?? (async (p) => ({
        result: { id: "resp_1", model: p.model, output: [] },
        queueWaitMs: 0,
      })),
    logPayloadSize: () => {},
  }
}

const responsesPayload: ResponsesTestPayload = {
  model: "gpt-4o",
  input: [{ type: "message", content: "hello" }],
}

/** Mock strategy that simulates token refresh behavior on 401 */
function createMockTokenRefreshStrategy(): RetryStrategy<ResponsesTestPayload> {
  return {
    name: "token-refresh",
    canHandle: (error) => error.status === 401,
    handle: async (_error, currentPayload) => ({
      action: "retry" as const,
      payload: currentPayload,
    }),
  }
}

describe("pipeline with responses-format adapter", () => {
  test("successful execution without retry", async () => {
    const adapter = createResponsesAdapter()

    const result = await executeRequestPipeline({
      adapter,
      strategies: [],
      payload: { ...responsesPayload },
      originalPayload: { ...responsesPayload },
      model: undefined,
      maxRetries: 1,
    })

    expect(result.response).toEqual({ id: "resp_1", model: "gpt-4o", output: [] })
    expect(result.totalRetries).toBe(0)
  })

  test("retries once on 401 with token-refresh strategy", async () => {
    let callCount = 0
    const adapter = createResponsesAdapter(async (p) => {
      callCount++
      if (callCount === 1) {
        throw new HTTPError("Unauthorized", 401, "")
      }
      return { result: { id: "resp_2", model: p.model, output: [] }, queueWaitMs: 0 }
    })

    const result = await executeRequestPipeline({
      adapter,
      strategies: [createMockTokenRefreshStrategy()],
      payload: { ...responsesPayload },
      originalPayload: { ...responsesPayload },
      model: undefined,
      maxRetries: 1,
    })

    expect(callCount).toBe(2)
    expect(result.totalRetries).toBe(1)
    expect(result.response).toEqual({ id: "resp_2", model: "gpt-4o", output: [] })
  })

  test("propagates error after exhausting retries", async () => {
    const executeFn = mock(async () => {
      throw new HTTPError("Unauthorized", 401, "")
    })
    const adapter = createResponsesAdapter(executeFn)

    await expect(
      executeRequestPipeline({
        adapter,
        strategies: [createMockTokenRefreshStrategy()],
        payload: { ...responsesPayload },
        originalPayload: { ...responsesPayload },
        model: undefined,
        maxRetries: 1,
      }),
    ).rejects.toThrow("Unauthorized")

    // 1 initial + 1 retry = 2 calls
    expect(executeFn).toHaveBeenCalledTimes(2)
  })

  test("records attempts on requestContext when provided", async () => {
    let callCount = 0
    const adapter = createResponsesAdapter(async (p) => {
      callCount++
      if (callCount === 1) {
        throw new HTTPError("Unauthorized", 401, "")
      }
      return { result: { id: "resp_3", model: p.model, output: [] }, queueWaitMs: 5 }
    })

    const manager = createRequestContextManager()
    const reqCtx = manager.create({ endpoint: "openai-chat-completions" })
    reqCtx.setOriginalRequest({ model: "gpt-4o", messages: [], stream: false, payload: {} })

    const result = await executeRequestPipeline({
      adapter,
      strategies: [createMockTokenRefreshStrategy()],
      payload: { ...responsesPayload },
      originalPayload: { ...responsesPayload },
      model: undefined,
      maxRetries: 1,
      requestContext: reqCtx,
    })

    expect(result.totalRetries).toBe(1)

    // Verify attempts were recorded on the context
    expect(reqCtx.attempts).toHaveLength(2)
    expect(reqCtx.attempts[0].error).toBeDefined()
    expect(reqCtx.attempts[0].error!.status).toBe(401)
    // Pipeline uses generic "retry" label, not the strategy's name
    expect(reqCtx.attempts[1].strategy).toBe("retry")
  })

  test("non-retryable error is not retried", async () => {
    const executeFn = mock(async () => {
      throw new HTTPError("Bad Request", 400, JSON.stringify({ error: { message: "invalid field" } }))
    })
    const adapter = createResponsesAdapter(executeFn)

    await expect(
      executeRequestPipeline({
        adapter,
        strategies: [createMockTokenRefreshStrategy()],
        payload: { ...responsesPayload },
        originalPayload: { ...responsesPayload },
        model: undefined,
        maxRetries: 1,
      }),
    ).rejects.toThrow("Bad Request")

    // Only 1 call — 400 is not handled by token-refresh (only 401)
    expect(executeFn).toHaveBeenCalledTimes(1)
  })
})
