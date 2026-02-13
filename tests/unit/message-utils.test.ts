// Unit tests for translation helpers.

import { describe, expect, test } from "bun:test"

import { mapOpenAIStopReasonToAnthropic } from "~/lib/translation/non-stream"

// ─── mapOpenAIStopReasonToAnthropic ───

describe("mapOpenAIStopReasonToAnthropic", () => {
  test("maps 'stop' to 'end_turn'", () => {
    expect(mapOpenAIStopReasonToAnthropic("stop")).toBe("end_turn")
  })

  test("maps 'length' to 'max_tokens'", () => {
    expect(mapOpenAIStopReasonToAnthropic("length")).toBe("max_tokens")
  })

  test("maps 'tool_calls' to 'tool_use'", () => {
    expect(mapOpenAIStopReasonToAnthropic("tool_calls")).toBe("tool_use")
  })

  test("maps 'content_filter' to 'end_turn'", () => {
    expect(mapOpenAIStopReasonToAnthropic("content_filter")).toBe("end_turn")
  })

  test("maps null to null", () => {
    expect(mapOpenAIStopReasonToAnthropic(null)).toBeNull()
  })
})
