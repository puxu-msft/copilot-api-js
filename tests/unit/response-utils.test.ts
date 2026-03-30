/**
 * Unit tests for response utility functions.
 *
 * Split from: characterization/shared-utils.test.ts
 * Tests: isNonStreaming, safeParseJson, prependMarkerToResponse
 */

import { describe, expect, test } from "bun:test"

import type { ChatCompletionResponse } from "~/types/api/openai-chat-completions"

import { isNonStreaming, prependMarkerToResponse, safeParseJson } from "~/lib/request/response"

describe("isNonStreaming", () => {
  test("returns true for response with choices property", () => {
    const response: ChatCompletionResponse = {
      id: "test",
      object: "chat.completion",
      created: Date.now(),
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop", logprobs: null }],
      model: "gpt-4",
    }
    expect(isNonStreaming(response)).toBe(true)
  })

  test("returns false for async iterable (streaming)", () => {
    const asyncIterable = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.resolve({ done: true, value: undefined })
          },
        }
      },
    }
    expect(isNonStreaming(asyncIterable as any)).toBe(false)
  })
})

describe("safeParseJson", () => {
  test("parses valid JSON strings", () => {
    expect(safeParseJson("{\"ok\":true}")).toEqual({ ok: true })
  })

  test("returns object inputs unchanged", () => {
    const input = { ok: true }
    expect(safeParseJson(input)).toBe(input)
  })

  test("returns an empty object for invalid JSON strings", () => {
    expect(safeParseJson("{ nope")).toEqual({})
  })
})

describe("prependMarkerToResponse", () => {
  test("returns the original response when marker is empty", () => {
    const response = {
      content: [{ type: "text", text: "hello" }] as Array<{ type: string; text?: string; id?: string }>,
    }

    expect(prependMarkerToResponse(response, "")).toBe(response)
  })

  test("prepends the marker to the first text block", () => {
    const response = {
      content: [
        { type: "tool_use", id: "tool-1" },
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ] as Array<{ type: string; text?: string; id?: string }>,
    }

    const result = prependMarkerToResponse(response, "[marker] ")

    expect(result.content).toEqual([
      { type: "tool_use", id: "tool-1" },
      { type: "text", text: "[marker] hello" },
      { type: "text", text: "world" },
    ])
    expect(response.content[1]).toEqual({ type: "text", text: "hello" })
  })

  test("treats missing text as an empty string", () => {
    const response = {
      content: [{ type: "text" }] as Array<{ type: string; text?: string; id?: string }>,
    }

    expect(prependMarkerToResponse(response, "[marker] ").content).toEqual([{ type: "text", text: "[marker] " }])
  })

  test("inserts a new text block when the response has no text content", () => {
    const response = {
      content: [{ type: "tool_use", id: "tool-1" }] as Array<{ type: string; text?: string; id?: string }>,
    }

    expect(prependMarkerToResponse(response, "[marker] ").content).toEqual([
      { type: "text", text: "[marker] " },
      { type: "tool_use", id: "tool-1" },
    ])
  })
})
