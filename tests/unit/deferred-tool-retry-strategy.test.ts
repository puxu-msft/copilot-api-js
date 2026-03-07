import { describe, expect, test } from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RetryContext } from "~/lib/request/pipeline"

import { createDeferredToolRetryStrategy, parseToolReferenceError } from "~/lib/request/strategies/deferred-tool-retry"

// ============================================================================
// Helpers
// ============================================================================

/** Build an ApiError that mimics HTTPError's shape:
 * `error.raw = { responseText: JSON.stringify({ error: { message } }) }` */
function toolReferenceError(toolName: string): ApiError {
  const msg = `Tool reference '${toolName}' not found in available tools`
  return {
    type: "bad_request",
    status: 400,
    message: msg,
    raw: {
      responseText: JSON.stringify({ error: { message: msg } }),
    },
  } as unknown as ApiError
}

function otherBadRequest(): ApiError {
  return {
    type: "bad_request",
    status: 400,
    message: "Invalid request",
    raw: {
      responseText: JSON.stringify({ error: { message: "Invalid request" } }),
    },
  } as unknown as ApiError
}

function serverError(): ApiError {
  return {
    type: "server_error",
    status: 500,
    message: "Internal server error",
    raw: undefined,
  } as unknown as ApiError
}

/** Anthropic Tool type: `name` at top level, not inside `function` */
interface TestPayload {
  model: string
  tools?: Array<{
    name: string
    description: string
    input_schema?: Record<string, unknown>
    defer_loading?: boolean
  }>
}

const retryContext: RetryContext<TestPayload> = {
  attempt: 0,
  maxRetries: 3,
  originalPayload: {} as TestPayload,
  model: undefined,
}

// ============================================================================
// parseToolReferenceError
// ============================================================================

describe("parseToolReferenceError", () => {
  test("extracts tool name from error message", () => {
    const result = parseToolReferenceError("Tool reference 'get_weather' not found in available tools")
    expect(result).toBe("get_weather")
  })

  test("extracts tool name with special characters", () => {
    const result = parseToolReferenceError("Tool reference 'my-tool_v2' not found in available tools")
    expect(result).toBe("my-tool_v2")
  })

  test("returns null for non-matching error messages", () => {
    expect(parseToolReferenceError("Invalid request")).toBeNull()
    expect(parseToolReferenceError("")).toBeNull()
    expect(parseToolReferenceError("Tool not found")).toBeNull()
  })
})

// ============================================================================
// createDeferredToolRetryStrategy
// ============================================================================

describe("createDeferredToolRetryStrategy", () => {
  test("has name 'deferred-tool-retry'", () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    expect(strategy.name).toBe("deferred-tool-retry")
  })

  // ── canHandle ──

  test("canHandle returns true for tool reference error", () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    expect(strategy.canHandle(toolReferenceError("get_weather"))).toBe(true)
  })

  test("canHandle returns false for non-400 errors", () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    expect(strategy.canHandle(serverError())).toBe(false)
  })

  test("canHandle returns false for 400 without tool reference", () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    expect(strategy.canHandle(otherBadRequest())).toBe(false)
  })

  test("canHandle returns false when raw is missing", () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    const error = {
      type: "bad_request",
      status: 400,
      message: "Tool reference 'x' not found",
      raw: undefined,
    } as unknown as ApiError
    expect(strategy.canHandle(error)).toBe(false)
  })

  test("canHandle returns false when raw has no responseText", () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    const error = {
      type: "bad_request",
      status: 400,
      message: "error",
      raw: { someOtherField: true },
    } as unknown as ApiError
    expect(strategy.canHandle(error)).toBe(false)
  })

  test("canHandle returns false for already-undeferred tool", async () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    const payload: TestPayload = {
      model: "test",
      tools: [{ name: "get_weather", description: "Get weather", defer_loading: true }],
    }

    await strategy.handle(toolReferenceError("get_weather"), payload, retryContext)
    expect(strategy.canHandle(toolReferenceError("get_weather"))).toBe(false)
  })

  // ── handle ──

  test("handle sets defer_loading to false for matching tool", async () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    const payload: TestPayload = {
      model: "test",
      tools: [
        { name: "get_weather", description: "Get weather", defer_loading: true },
        { name: "search", description: "Search", defer_loading: true },
      ],
    }

    const result = await strategy.handle(toolReferenceError("get_weather"), payload, retryContext)

    expect(result.action).toBe("retry")
    const modifiedTool = (result as any).payload.tools.find((t: any) => t.name === "get_weather")
    expect(modifiedTool?.defer_loading).toBe(false)

    // Other tools should remain unchanged
    const otherTool = (result as any).payload.tools.find((t: any) => t.name === "search")
    expect(otherTool?.defer_loading).toBe(true)
  })

  test("handle injects stub when tool not found in payload (safety net)", async () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    const payload: TestPayload = {
      model: "test",
      tools: [{ name: "search", description: "Search" }],
    }

    const result = await strategy.handle(toolReferenceError("nonexistent_tool"), payload, retryContext)

    // Should retry (not abort) with the stub injected
    expect(result.action).toBe("retry")
    const retryPayload = (result as { payload: TestPayload }).payload
    expect(retryPayload.tools).toHaveLength(2)

    const stub = retryPayload.tools!.find((t) => t.name === "nonexistent_tool")
    expect(stub).toBeDefined()
    expect(stub!.description).toBe("Tool referenced in conversation history")
    expect(stub!.defer_loading).toBeUndefined()
  })

  test("handle injects stub and marks tool as undeferred (prevents duplicate retry)", async () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    const payload: TestPayload = {
      model: "test",
      tools: [{ name: "search", description: "Search" }],
    }

    // First call: injects stub
    await strategy.handle(toolReferenceError("missing_tool"), payload, retryContext)

    // Second call for same tool: canHandle returns false (already undeferred)
    expect(strategy.canHandle(toolReferenceError("missing_tool"))).toBe(false)
  })

  test("handle returns abort when payload has no tools", async () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    const payload: TestPayload = { model: "test" }

    const result = await strategy.handle(toolReferenceError("get_weather"), payload, retryContext)
    expect(result.action).toBe("abort")
  })

  test("handle includes meta with undeferredTool", async () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    const payload: TestPayload = {
      model: "test",
      tools: [{ name: "get_weather", description: "Get weather", defer_loading: true }],
    }

    const result = await strategy.handle(toolReferenceError("get_weather"), payload, retryContext)
    expect((result as any).meta).toEqual({ undeferredTool: "get_weather" })
  })

  test("handle does not mutate original payload", async () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    const payload: TestPayload = {
      model: "test",
      tools: [{ name: "get_weather", description: "Weather", defer_loading: true }],
    }

    await strategy.handle(toolReferenceError("get_weather"), payload, retryContext)
    expect(payload.tools![0].defer_loading).toBe(true)
  })

  test("handle can undefer multiple different tools sequentially", async () => {
    const strategy = createDeferredToolRetryStrategy<TestPayload>()
    const payload: TestPayload = {
      model: "test",
      tools: [
        { name: "tool_a", description: "A", defer_loading: true },
        { name: "tool_b", description: "B", defer_loading: true },
      ],
    }

    const result1 = await strategy.handle(toolReferenceError("tool_a"), payload, retryContext)
    expect(result1.action).toBe("retry")

    expect(strategy.canHandle(toolReferenceError("tool_b"))).toBe(true)
    expect(strategy.canHandle(toolReferenceError("tool_a"))).toBe(false)
  })
})
