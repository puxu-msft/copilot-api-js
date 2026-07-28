/**
 * Unit tests for the provenance-preserving refusal detail parsing + honest thinking-token
 * extraction (spec docs/spec/2026-07-27-refusal-diagnostics-and-typing.md §4.2/§4.3).
 *
 * These lock the two invariants the 2026-07-27 incident exposed:
 *  - `stop_details` normalization must NOT collapse `null` / absent / malformed into one value —
 *    `category:null` (upstream explicitly says "unmapped") is a real observed wire shape, distinct
 *    from "the field was never sent" (the 2026-06-23 sample's era) and from a malformed type.
 *  - thinking tokens are ONLY knowable from `output_tokens_details.thinking_tokens`. Falling back to
 *    `output_tokens` is a lie: the real `bio` sample carried a single thinking block yet
 *    output_tokens=25848 vs thinking_tokens=25636 (a 212 gap).
 *
 * Expected values are hand-written literals — never imported from the production constants under
 * test (an import-as-expected golden goes green when production and expectation change together).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  extractRefusalDetail,
  isContentlessRefusal,
  isNamedCategory,
  refusalThinkingTokens,
  renderRefusalTemplate,
} from "~/lib/anthropic/recover-refusal"

describe("extractRefusalDetail — provenance is preserved, never collapsed", () => {
  test("named category (real `cyber` sample shape)", () => {
    const out = extractRefusalDetail({ type: "refusal", category: "cyber", explanation: "This request triggered restrictions on violative cyber content" })
    expect(out).toEqual({ category: "cyber", explanation: "This request triggered restrictions on violative cyber content", invalid: false })
  })

  test("category:null (real 2026-06-23 sample shape) stays null — NOT undefined, NOT empty string", () => {
    const out = extractRefusalDetail({ type: "refusal", category: null, explanation: "API integrators: you can reduce refusals" })
    expect(out.category).toBeNull()
    expect(out.explanation).toBe("API integrators: you can reduce refusals")
    expect(out.invalid).toBe(false)
  })

  test("stop_details absent → undefined (distinct from an explicit null)", () => {
    expect(extractRefusalDetail(undefined)).toEqual({ category: undefined, explanation: undefined, invalid: false })
  })

  test("stop_details === null → undefined fields, not invalid", () => {
    expect(extractRefusalDetail(null)).toEqual({ category: undefined, explanation: undefined, invalid: false })
  })

  test("category key missing from an otherwise valid stop_details", () => {
    expect(extractRefusalDetail({ type: "refusal" })).toEqual({ category: undefined, explanation: undefined, invalid: false })
  })

  test("empty-string category is kept verbatim but flagged invalid (malformed, not 'unmapped')", () => {
    const out = extractRefusalDetail({ type: "refusal", category: "" })
    expect(out.category).toBe("")
    expect(out.invalid).toBe(true)
  })

  test("non-string category → undefined + invalid", () => {
    expect(extractRefusalDetail({ type: "refusal", category: 123 })).toEqual({ category: undefined, explanation: undefined, invalid: true })
  })

  test("non-object stop_details → invalid, never throws", () => {
    expect(extractRefusalDetail("refusal")).toEqual({ category: undefined, explanation: undefined, invalid: true })
    expect(extractRefusalDetail(42)).toEqual({ category: undefined, explanation: undefined, invalid: true })
  })
})

describe("isNamedCategory — the ONLY gate is 'non-empty string'", () => {
  test("true only for a non-empty string", () => {
    expect(isNamedCategory("cyber")).toBe(true)
    expect(isNamedCategory("bio")).toBe(true)
    expect(isNamedCategory(null)).toBe(false)
    expect(isNamedCategory(undefined)).toBe(false)
    expect(isNamedCategory("")).toBe(false)
  })
})

describe("refusalThinkingTokens — unknown stays unknown", () => {
  test("reads the authoritative breakdown when present (real cyber sample: 0, not output_tokens 1)", () => {
    expect(refusalThinkingTokens({ output_tokens: 1, output_tokens_details: { thinking_tokens: 0 } })).toBe(0)
  })

  test("real bio sample: 25636, NOT the 25848 total", () => {
    expect(refusalThinkingTokens({ output_tokens: 25848, output_tokens_details: { thinking_tokens: 25636 } })).toBe(25636)
  })

  test("no output_tokens_details (2026-06-23 era) → undefined, NOT the 1097 total", () => {
    expect(refusalThinkingTokens({ output_tokens: 1097 })).toBeUndefined()
  })

  test("malformed / negative / non-finite breakdown → undefined", () => {
    expect(refusalThinkingTokens({ output_tokens: 9, output_tokens_details: { thinking_tokens: -1 } })).toBeUndefined()
    expect(refusalThinkingTokens({ output_tokens: 9, output_tokens_details: { thinking_tokens: Number.NaN } })).toBeUndefined()
    expect(refusalThinkingTokens({ output_tokens: 9, output_tokens_details: { thinking_tokens: "5" } })).toBeUndefined()
    expect(refusalThinkingTokens(undefined)).toBeUndefined()
  })
})

describe("renderRefusalTemplate — unknown values render as documented words, never as a wrong number", () => {
  const vars = {
    model: "claude-opus-5",
    request_id: "req_1",
    thinking_tokens: undefined,
    output_tokens: 1,
    refusal_category: "cyber" as string | null | undefined,
    refusal_explanation: "blocked" as string | null | undefined,
  }

  test("unknown thinking_tokens renders `unknown` (never the output_tokens total)", () => {
    expect(renderRefusalTemplate("t={thinking_tokens} o={output_tokens}", vars)).toBe("t=unknown o=1")
  })

  test("known thinking_tokens renders the number, including 0", () => {
    expect(renderRefusalTemplate("t={thinking_tokens}", { ...vars, thinking_tokens: 0 })).toBe("t=0")
  })

  test("named category renders verbatim", () => {
    expect(renderRefusalTemplate("c={refusal_category}", vars)).toBe("c=cyber")
  })

  test("category null renders `uncategorized`, absent renders `unknown` (the distinction survives)", () => {
    expect(renderRefusalTemplate("c={refusal_category}", { ...vars, refusal_category: null })).toBe("c=uncategorized")
    expect(renderRefusalTemplate("c={refusal_category}", { ...vars, refusal_category: undefined })).toBe("c=unknown")
  })

  test("explanation null/absent renders `unknown`", () => {
    expect(renderRefusalTemplate("e={refusal_explanation}", { ...vars, refusal_explanation: null })).toBe("e=unknown")
  })

  test("unknown placeholders stay verbatim; no-placeholder text is byte-identical", () => {
    expect(renderRefusalTemplate("keep {nope} and {model}", vars)).toBe("keep {nope} and claude-opus-5")
    expect(renderRefusalTemplate("plain text", vars)).toBe("plain text")
    expect(renderRefusalTemplate("", vars)).toBe("")
  })
})

describe("isContentlessRefusal — renamed gate, semantics unchanged", () => {
  test("true only for stop_reason refusal with no client-visible content", () => {
    expect(isContentlessRefusal("refusal", false)).toBe(true)
    expect(isContentlessRefusal("refusal", true)).toBe(false)
    expect(isContentlessRefusal("end_turn", false)).toBe(false)
    expect(isContentlessRefusal(null, false)).toBe(false)
    expect(isContentlessRefusal(undefined, false)).toBe(false)
  })

  test("covers all three observed sample shapes (2 thinking-only + 1 zero-block)", () => {
    // All three real samples had no text/tool_use, so the gate fires for each.
    expect(isContentlessRefusal("refusal", false)).toBe(true)
  })
})
