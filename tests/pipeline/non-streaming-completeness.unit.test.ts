import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  anthropicNonStreamingTruncation,
  openaiNonStreamingTruncation,
  responsesNonStreamingTruncation,
} from "~/lib/pipeline/non-streaming-completeness"

describe("non-streaming semantic-truncation detection", () => {
  test("anthropic: missing stop_reason → reason; present → null", () => {
    expect(anthropicNonStreamingTruncation(undefined)).toContain("stop_reason")
    expect(anthropicNonStreamingTruncation(null)).toContain("stop_reason")
    expect(anthropicNonStreamingTruncation("")).toContain("stop_reason")
    expect(anthropicNonStreamingTruncation("end_turn")).toBeNull()
    expect(anthropicNonStreamingTruncation("tool_use")).toBeNull()
    expect(anthropicNonStreamingTruncation("max_tokens")).toBeNull() // explicit terminal, not truncation
  })

  test("openai/gemini: missing finish_reason → reason; present → null", () => {
    expect(openaiNonStreamingTruncation(undefined)).toContain("finish_reason")
    expect(openaiNonStreamingTruncation(null)).toContain("finish_reason")
    expect(openaiNonStreamingTruncation("stop")).toBeNull()
    expect(openaiNonStreamingTruncation("length")).toBeNull() // explicit terminal
    expect(openaiNonStreamingTruncation("tool_calls")).toBeNull()
  })

  test("responses: missing/in_progress status → reason; terminal status → null", () => {
    expect(responsesNonStreamingTruncation(undefined)).toContain("semantic truncation")
    expect(responsesNonStreamingTruncation("in_progress")).toContain("in_progress")
    expect(responsesNonStreamingTruncation("completed")).toBeNull()
    expect(responsesNonStreamingTruncation("incomplete")).toBeNull() // explicit terminal (e.g. max_output_tokens)
    expect(responsesNonStreamingTruncation("failed")).toBeNull() // explicit terminal
  })
})
