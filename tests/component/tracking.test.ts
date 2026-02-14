/**
 * Component tests for request finalization and error content extraction.
 *
 * Tests: finalizeRequest, extractErrorContent
 */

import { describe, expect, spyOn, test } from "bun:test"

import type { ResponseContext } from "~/routes/shared/tracking"

import { HTTPError } from "~/lib/error"
import * as history from "~/lib/history"
import * as tui from "~/lib/tui"
import { extractErrorContent, finalizeRequest } from "~/routes/shared/tracking"

// Mock recordResponse and tuiLogger to avoid side effects
const recordResponseSpy = spyOn(history, "recordResponse").mockImplementation(() => {})
const trackerInstance = tui.tuiLogger
const updateSpy = spyOn(trackerInstance, "updateRequest").mockImplementation(() => {})
const completeSpy = spyOn(trackerInstance, "completeRequest").mockImplementation(() => {})
const failSpy = spyOn(trackerInstance, "failRequest").mockImplementation(() => {})

function makeCtx(overrides?: Partial<ResponseContext>): ResponseContext {
  return {
    historyId: "test-history-id",
    tuiLogId: "track-1",
    startTime: Date.now() - 100,
    ...overrides,
  }
}

// ─── extractErrorContent ───

describe("extractErrorContent", () => {
  test("extracts HTTP response body as formatted content", () => {
    const jsonBody = JSON.stringify({ error: { message: "Token limit exceeded" } })
    const error = new HTTPError("Token limit", 400, jsonBody)

    const content = extractErrorContent(error)
    expect(content).not.toBeNull()
    const textBlock = content!.content[0]
    expect(textBlock.text).toContain("API Error Response")
    expect(textBlock.text).toContain("HTTP 400")
    expect(textBlock.text).toContain("Token limit exceeded")
  })

  test("formats JSON response body for display", () => {
    const jsonBody = '{"key":"value"}'
    const error = new HTTPError("Error", 500, jsonBody)

    const content = extractErrorContent(error)
    expect(content).not.toBeNull()
    expect(content!.content[0].text).toContain('"key": "value"')
  })

  test("returns null for error without responseText", () => {
    const content = extractErrorContent(new Error("Generic error"))
    expect(content).toBeNull()
  })

  test("returns null for non-Error values", () => {
    expect(extractErrorContent("string error")).toBeNull()
    expect(extractErrorContent(42)).toBeNull()
  })
})

// ─── finalizeRequest ───

describe("finalizeRequest", () => {
  test("records success to both history and TUI", () => {
    recordResponseSpy.mockClear()
    updateSpy.mockClear()
    completeSpy.mockClear()

    const ctx = makeCtx()
    finalizeRequest(ctx, {
      success: true,
      model: "claude-sonnet-4",
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: "end_turn",
      content: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      durationMs: 200,
      queueWaitMs: 10,
    })

    // History
    expect(recordResponseSpy).toHaveBeenCalledTimes(1)
    const historyCall = recordResponseSpy.mock.calls[0]
    expect(historyCall[0]).toBe("test-history-id")
    expect(historyCall[1].success).toBe(true)
    expect(historyCall[1].model).toBe("claude-sonnet-4")
    expect(historyCall[1].usage.input_tokens).toBe(100)
    expect(historyCall[2]).toBe(200) // durationMs

    // TUI
    expect(updateSpy).toHaveBeenCalledWith("track-1", {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: undefined,
      cacheCreationInputTokens: undefined,
      queueWaitMs: 10,
    })
    expect(completeSpy).toHaveBeenCalledWith("track-1", 200, {
      inputTokens: 100,
      outputTokens: 50,
    })
  })

  test("records failure to both history and TUI", () => {
    recordResponseSpy.mockClear()
    failSpy.mockClear()

    const ctx = makeCtx()
    finalizeRequest(ctx, {
      success: false,
      model: "gpt-4",
      usage: { input_tokens: 0, output_tokens: 0 },
      error: "Something broke",
      content: null,
      durationMs: 50,
    })

    // History
    const historyCall = recordResponseSpy.mock.calls[0]
    expect(historyCall[1].success).toBe(false)
    expect(historyCall[1].error).toBe("Something broke")
    expect(historyCall[1].content).toBeNull()

    // TUI
    expect(failSpy).toHaveBeenCalledWith("track-1", "Something broke")
  })

  test("records error with HTTP response body as content", () => {
    recordResponseSpy.mockClear()

    const ctx = makeCtx()
    const jsonBody = JSON.stringify({ error: { message: "Token limit exceeded" } })
    const error = new HTTPError("Token limit", 400, jsonBody)
    const content = extractErrorContent(error)

    finalizeRequest(ctx, {
      success: false,
      model: "claude-sonnet-4",
      usage: { input_tokens: 0, output_tokens: 0 },
      error: "Token limit",
      content,
      durationMs: 100,
    })

    const historyCall = recordResponseSpy.mock.calls[0]
    expect(historyCall[1].content).not.toBeNull()
    const textBlock = (historyCall[1].content as any).content[0]
    expect(textBlock.text).toContain("HTTP 400")
  })

  test("records partial stream content on error", () => {
    recordResponseSpy.mockClear()

    const ctx = makeCtx()
    finalizeRequest(ctx, {
      success: false,
      model: "claude-sonnet-4",
      usage: { input_tokens: 100, output_tokens: 50 },
      error: "Stream broke",
      content: { role: "assistant", content: [{ type: "text", text: "Partial response before error..." }] },
      durationMs: 150,
    })

    const historyCall = recordResponseSpy.mock.calls[0]
    expect(historyCall[1].success).toBe(false)
    expect(historyCall[1].model).toBe("claude-sonnet-4")
    expect(historyCall[1].usage.input_tokens).toBe(100)
    const textBlock = (historyCall[1].content as any).content[0]
    expect(textBlock.text).toBe("Partial response before error...")
  })

  test("uses fallback model when no model in accumulator", () => {
    recordResponseSpy.mockClear()

    const ctx = makeCtx()
    finalizeRequest(ctx, {
      success: false,
      model: "my-fallback",
      usage: { input_tokens: 0, output_tokens: 0 },
      error: "err",
      content: null,
      durationMs: 50,
    })

    const historyCall = recordResponseSpy.mock.calls[0]
    expect(historyCall[1].model).toBe("my-fallback")
  })

  test("skips TUI when no tuiLogId", () => {
    recordResponseSpy.mockClear()
    updateSpy.mockClear()
    completeSpy.mockClear()

    const ctx = makeCtx({ tuiLogId: undefined })
    finalizeRequest(ctx, {
      success: true,
      model: "gpt-4",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: null,
      durationMs: 100,
    })

    // History still recorded
    expect(recordResponseSpy).toHaveBeenCalledTimes(1)
    // TUI not called
    expect(updateSpy).not.toHaveBeenCalled()
    expect(completeSpy).not.toHaveBeenCalled()
  })

  test("passes cache tokens to TUI", () => {
    updateSpy.mockClear()

    const ctx = makeCtx()
    finalizeRequest(ctx, {
      success: true,
      model: "claude-sonnet-4",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
      content: null,
      durationMs: 100,
    })

    expect(updateSpy).toHaveBeenCalledWith(
      "track-1",
      expect.objectContaining({
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 20,
      }),
    )
  })
})
