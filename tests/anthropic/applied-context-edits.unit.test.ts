/**
 * Unit tests for the upstream context_management.applied_edits diagnostic summarizer.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  extractAppliedEdits,
  summarizeAppliedEdits,
} from "~/lib/anthropic/applied-context-edits"

describe("summarizeAppliedEdits", () => {
  test("empty array → no clears", () => {
    expect(summarizeAppliedEdits([])).toEqual({ count: 0, clearedInputTokens: 0, types: [] })
  })

  test("non-array / null → no clears", () => {
    expect(summarizeAppliedEdits(undefined)).toEqual({ count: 0, clearedInputTokens: 0, types: [] })
    expect(summarizeAppliedEdits(null)).toEqual({ count: 0, clearedInputTokens: 0, types: [] })
    expect(summarizeAppliedEdits({})).toEqual({ count: 0, clearedInputTokens: 0, types: [] })
  })

  test("sums cleared_input_tokens and collects types", () => {
    const edits = [
      { type: "clear_tool_uses_20250919", cleared_tool_uses: 4, cleared_input_tokens: 12000 },
      { type: "clear_thinking_20251015", cleared_input_tokens: 800 },
    ]
    expect(summarizeAppliedEdits(edits)).toEqual({ count: 2, clearedInputTokens: 12800, types: ["clear_tool_uses_20250919", "clear_thinking_20251015"] })
  })

  test("tolerates missing fields", () => {
    expect(summarizeAppliedEdits([{ type: "x" }, {}, 5, null])).toEqual({ count: 4, clearedInputTokens: 0, types: ["x"] })
  })
})

describe("extractAppliedEdits", () => {
  test("pulls applied_edits array", () => {
    expect(extractAppliedEdits({ applied_edits: [{ type: "a" }] })).toEqual([{ type: "a" }])
  })

  test("missing / wrong shape → empty", () => {
    expect(extractAppliedEdits(undefined)).toEqual([])
    expect(extractAppliedEdits({ applied_edits: [] })).toEqual([])
    expect(extractAppliedEdits({ applied_edits: "nope" })).toEqual([])
  })
})
