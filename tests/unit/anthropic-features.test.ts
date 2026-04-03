import { describe, expect, test } from "bun:test"

import {
  buildAnthropicBetaHeaders,
  modelSupportsContextEditing,
  modelSupportsInterleavedThinking,
  modelSupportsToolSearch,
} from "~/lib/anthropic/features"

describe("modelSupportsInterleavedThinking", () => {
  test("should support claude-opus-4.6", () => {
    expect(modelSupportsInterleavedThinking("claude-opus-4.6")).toBe(true)
  })

  test("should support claude-opus-4-6 (hyphenated)", () => {
    expect(modelSupportsInterleavedThinking("claude-opus-4-6")).toBe(true)
  })

  test("should support claude-opus-4.5", () => {
    expect(modelSupportsInterleavedThinking("claude-opus-4.5")).toBe(true)
  })

  test("should support claude-sonnet-4.5", () => {
    expect(modelSupportsInterleavedThinking("claude-sonnet-4.5")).toBe(true)
  })

  test("should support claude-sonnet-4", () => {
    expect(modelSupportsInterleavedThinking("claude-sonnet-4")).toBe(true)
  })

  test("should support claude-haiku-4.5", () => {
    expect(modelSupportsInterleavedThinking("claude-haiku-4.5")).toBe(true)
  })

  test("should NOT support claude-opus-4 (base)", () => {
    // claude-opus-4 does NOT support interleaved thinking per design
    expect(modelSupportsInterleavedThinking("claude-opus-4")).toBe(false)
  })

  test("should NOT support claude-opus-4.1 / claude-opus-41", () => {
    expect(modelSupportsInterleavedThinking("claude-opus-4.1")).toBe(false)
    expect(modelSupportsInterleavedThinking("claude-opus-41")).toBe(false)
  })

  test("should NOT support non-Claude models", () => {
    expect(modelSupportsInterleavedThinking("gpt-4")).toBe(false)
    expect(modelSupportsInterleavedThinking("gpt-4o")).toBe(false)
    expect(modelSupportsInterleavedThinking("gemini-2.5-pro")).toBe(false)
  })
})

describe("modelSupportsContextEditing", () => {
  test("should support claude-opus-4.6", () => {
    expect(modelSupportsContextEditing("claude-opus-4.6")).toBe(true)
  })

  test("should support claude-opus-4-6 (hyphenated)", () => {
    expect(modelSupportsContextEditing("claude-opus-4-6")).toBe(true)
  })

  test("should support claude-opus-4.5", () => {
    expect(modelSupportsContextEditing("claude-opus-4.5")).toBe(true)
  })

  test("should support claude-opus-4.1 / claude-opus-41", () => {
    expect(modelSupportsContextEditing("claude-opus-4.1")).toBe(true)
    expect(modelSupportsContextEditing("claude-opus-41")).toBe(true)
  })

  test("should support claude-opus-4 (base)", () => {
    // claude-opus-4 supports context editing (broader set)
    expect(modelSupportsContextEditing("claude-opus-4")).toBe(true)
  })

  test("should support claude-sonnet-4.5", () => {
    expect(modelSupportsContextEditing("claude-sonnet-4.5")).toBe(true)
  })

  test("should support claude-sonnet-4.6", () => {
    expect(modelSupportsContextEditing("claude-sonnet-4.6")).toBe(true)
  })

  test("should support claude-sonnet-4", () => {
    expect(modelSupportsContextEditing("claude-sonnet-4")).toBe(true)
  })

  test("should support claude-haiku-4.5", () => {
    expect(modelSupportsContextEditing("claude-haiku-4.5")).toBe(true)
  })

  test("should NOT match future-lookalike model ids by prefix accident", () => {
    expect(modelSupportsContextEditing("claude-sonnet-40")).toBe(false)
    expect(modelSupportsContextEditing("claude-opus-40")).toBe(false)
  })

  test("should NOT support non-Claude models", () => {
    expect(modelSupportsContextEditing("gpt-4")).toBe(false)
    expect(modelSupportsContextEditing("gemini-2.5-pro")).toBe(false)
  })
})

describe("modelSupportsToolSearch", () => {
  test("should support claude-opus-4.6", () => {
    expect(modelSupportsToolSearch("claude-opus-4.6")).toBe(true)
  })

  test("should support claude-opus-4-6 (hyphenated)", () => {
    expect(modelSupportsToolSearch("claude-opus-4-6")).toBe(true)
  })

  test("should support claude-opus-4.5", () => {
    expect(modelSupportsToolSearch("claude-opus-4.5")).toBe(true)
  })

  test("should support claude-sonnet-4.5", () => {
    expect(modelSupportsToolSearch("claude-sonnet-4.5")).toBe(true)
  })

  test("should support claude-sonnet-4.6", () => {
    expect(modelSupportsToolSearch("claude-sonnet-4.6")).toBe(true)
  })

  test("should NOT support claude-opus-4 (base)", () => {
    expect(modelSupportsToolSearch("claude-opus-4")).toBe(false)
  })

  test("should NOT support claude-opus-4.1 / claude-opus-41", () => {
    expect(modelSupportsToolSearch("claude-opus-4.1")).toBe(false)
    expect(modelSupportsToolSearch("claude-opus-41")).toBe(false)
  })

  test("should NOT support unsupported claude-sonnet models", () => {
    expect(modelSupportsToolSearch("claude-sonnet-4")).toBe(false)
  })

  test("should NOT support claude-haiku models", () => {
    expect(modelSupportsToolSearch("claude-haiku-4.5")).toBe(false)
  })

  test("should NOT support non-Claude models", () => {
    expect(modelSupportsToolSearch("gpt-4")).toBe(false)
    expect(modelSupportsToolSearch("gemini-2.5-pro")).toBe(false)
  })
})

describe("buildAnthropicBetaHeaders", () => {
  test("omits context-management beta when explicitly disabled", () => {
    const headers = buildAnthropicBetaHeaders("claude-opus-4.6", undefined, {
      disableContextManagement: true,
    })

    expect(headers["anthropic-beta"]).toContain("advanced-tool-use-2025-11-20")
    expect(headers["anthropic-beta"]).not.toContain("context-management-2025-06-27")
  })
})
