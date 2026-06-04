import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  getStickyUndeferredTools,
  getSupportedEfforts,
  getUnsupportedFeatures,
  isAnthropicBetaUnsupported,
  isAnthropicFeatureUnsupported,
  isToolStickyUndeferred,
  markAnthropicBetaUnsupported,
  markAnthropicFeatureUnsupported,
  markToolUndeferred,
  resetAnthropicFeatureNegotiationForTesting,
  setSupportedEfforts,
} from "~/lib/anthropic/feature-negotiation"

afterEach(async () => {
  await resetAnthropicFeatureNegotiationForTesting()
})

describe("feature negotiation cache — features", () => {
  test("mark + check round-trips", () => {
    markAnthropicFeatureUnsupported("claude-opus-4.6", "context_management")
    expect(isAnthropicFeatureUnsupported("claude-opus-4.6", "context_management")).toBe(true)
  })

  test("getUnsupportedFeatures returns all", () => {
    markAnthropicFeatureUnsupported("m1", "context_management")
    markAnthropicFeatureUnsupported("m1", "another_field")
    expect(getUnsupportedFeatures("m1").sort()).toEqual(["another_field", "context_management"])
  })

  test("entries are per-model", () => {
    markAnthropicFeatureUnsupported("m1", "x")
    expect(isAnthropicFeatureUnsupported("m2", "x")).toBe(false)
  })
})

describe("feature negotiation cache — betas", () => {
  test("mark + check round-trips", () => {
    markAnthropicBetaUnsupported("claude-opus-4.7-1m-internal", "context-1m-2025-08-07")
    expect(isAnthropicBetaUnsupported("claude-opus-4.7-1m-internal", "context-1m-2025-08-07")).toBe(true)
  })

  test("ignores empty/whitespace tokens", () => {
    markAnthropicBetaUnsupported("m1", "")
    markAnthropicBetaUnsupported("m1", "   ")
    expect(isAnthropicBetaUnsupported("m1", "")).toBe(false)
  })
})

describe("feature negotiation cache — efforts", () => {
  test("set + get round-trips", () => {
    expect(setSupportedEfforts("claude-opus-4.7", ["medium"])).toBe(true)
    expect(getSupportedEfforts("claude-opus-4.7")).toEqual(["medium"])
  })

  test("set returns false when value is unchanged", () => {
    setSupportedEfforts("claude-opus-4.7", ["medium"])
    expect(setSupportedEfforts("claude-opus-4.7", ["medium"])).toBe(false)
  })

  test("set returns true when value differs", () => {
    setSupportedEfforts("m1", ["low"])
    expect(setSupportedEfforts("m1", ["low", "medium"])).toBe(true)
    expect(getSupportedEfforts("m1")).toEqual(["low", "medium"])
  })
})

describe("feature negotiation cache — deferred tools", () => {
  test("mark + check round-trips", () => {
    markToolUndeferred("claude-opus-4.6", "read_file")
    expect(isToolStickyUndeferred("claude-opus-4.6", "read_file")).toBe(true)
    expect(getStickyUndeferredTools("claude-opus-4.6")).toEqual(["read_file"])
  })

  test("ignores empty tool names", () => {
    markToolUndeferred("m1", "")
    expect(getStickyUndeferredTools("m1")).toEqual([])
  })

  test("entries are per-model", () => {
    markToolUndeferred("m1", "Read")
    expect(isToolStickyUndeferred("m2", "Read")).toBe(false)
  })
})

describe("feature negotiation cache — reset clears everything", () => {
  test("all categories reset", async () => {
    markAnthropicFeatureUnsupported("m", "f")
    markAnthropicBetaUnsupported("m", "b")
    setSupportedEfforts("m", ["medium"])
    markToolUndeferred("m", "t")
    await resetAnthropicFeatureNegotiationForTesting()
    expect(isAnthropicFeatureUnsupported("m", "f")).toBe(false)
    expect(isAnthropicBetaUnsupported("m", "b")).toBe(false)
    expect(getSupportedEfforts("m")).toBeUndefined()
    expect(isToolStickyUndeferred("m", "t")).toBe(false)
  })
})
