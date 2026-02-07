/**
 * Unit tests for response utility functions.
 *
 * Split from: characterization/shared-utils.test.ts
 * Tests: isNonStreaming
 */

import { describe, expect, test } from "bun:test"

import type { ChatCompletionResponse } from "~/types/api/openai"

import { isNonStreaming } from "~/routes/shared"

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
