/**
 * Component tests for TUI request tracking helpers.
 *
 * Tests: recordErrorResponse, recordStreamError
 */

import { describe, expect, spyOn, test } from "bun:test"

import type { ResponseContext } from "~/routes/shared/tracking"

import { HTTPError } from "~/lib/error"
import * as history from "~/lib/history"
import { recordErrorResponse, recordStreamError } from "~/routes/shared/tracking"

// Mock recordResponse to avoid filesystem side effects
const recordResponseSpy = spyOn(history, "recordResponse").mockImplementation(() => {})

function makeCtx(overrides?: Partial<ResponseContext>): ResponseContext {
  return {
    historyId: "test-history-id",
    trackingId: "track-1",
    startTime: Date.now() - 100,
    ...overrides,
  }
}

// ─── recordErrorResponse ───

describe("recordErrorResponse", () => {
  test("records error with model and message", () => {
    const ctx = makeCtx()
    recordErrorResponse(ctx, "gpt-4", new Error("Something broke"))

    expect(recordResponseSpy).toHaveBeenCalled()
    const lastCall = recordResponseSpy.mock.calls.at(-1)!
    expect(lastCall[0]).toBe("test-history-id")
    expect(lastCall[1].success).toBe(false)
    expect(lastCall[1].model).toBe("gpt-4")
    expect(lastCall[1].error).toBe("Something broke")
  })

  test("includes HTTP response body as formatted content when available", () => {
    const ctx = makeCtx()
    const jsonBody = JSON.stringify({ error: { message: "Token limit exceeded" } })
    const error = new HTTPError("Token limit", 400, jsonBody)

    recordErrorResponse(ctx, "claude-sonnet-4", error)

    const lastCall = recordResponseSpy.mock.calls.at(-1)!
    expect(lastCall[1].content).not.toBeNull()
    const textBlock = (lastCall[1].content as any).content[0]
    expect(textBlock.text).toContain("API Error Response")
    expect(textBlock.text).toContain("HTTP 400")
    expect(textBlock.text).toContain("Token limit exceeded")
  })

  test("formats JSON response body for display", () => {
    const ctx = makeCtx()
    const jsonBody = '{"key":"value"}'
    const error = new HTTPError("Error", 500, jsonBody)

    recordErrorResponse(ctx, "gpt-4", error)

    const lastCall = recordResponseSpy.mock.calls.at(-1)!
    const textBlock = (lastCall[1].content as any).content[0]
    expect(textBlock.text).toContain('"key": "value"')
  })

  test("handles error without responseText", () => {
    const ctx = makeCtx()
    recordErrorResponse(ctx, "gpt-4", new Error("Generic error"))

    const lastCall = recordResponseSpy.mock.calls.at(-1)!
    expect(lastCall[1].content).toBeNull()
    expect(lastCall[1].error).toBe("Generic error")
  })
})

// ─── recordStreamError ───

describe("recordStreamError", () => {
  test("records error with partial accumulated content", () => {
    const ctx = makeCtx()
    const acc = {
      model: "claude-sonnet-4",
      inputTokens: 100,
      outputTokens: 50,
      content: "Partial response before error...",
    }

    recordStreamError({ acc, fallbackModel: "fallback", ctx, error: new Error("Stream broke") })

    const lastCall = recordResponseSpy.mock.calls.at(-1)!
    expect(lastCall[1].success).toBe(false)
    expect(lastCall[1].model).toBe("claude-sonnet-4")
    expect(lastCall[1].usage.input_tokens).toBe(100)
    const textBlock = (lastCall[1].content as any).content[0]
    expect(textBlock.text).toBe("Partial response before error...")
    expect(lastCall[1].error).toBe("Stream broke")
  })

  test("records error with empty accumulator", () => {
    const ctx = makeCtx()
    const acc = {
      model: "",
      inputTokens: 0,
      outputTokens: 0,
      content: "",
    }

    recordStreamError({ acc, fallbackModel: "gpt-4-fallback", ctx, error: new Error("Immediate failure") })

    const lastCall = recordResponseSpy.mock.calls.at(-1)!
    expect(lastCall[1].model).toBe("gpt-4-fallback")
    expect(lastCall[1].content).toBeNull()
    expect(lastCall[1].error).toBe("Immediate failure")
  })

  test("uses fallback model when accumulator model is empty", () => {
    const ctx = makeCtx()
    const acc = { model: "", inputTokens: 0, outputTokens: 0, content: "" }

    recordStreamError({ acc, fallbackModel: "my-fallback", ctx, error: new Error("err") })

    const lastCall = recordResponseSpy.mock.calls.at(-1)!
    expect(lastCall[1].model).toBe("my-fallback")
  })
})
