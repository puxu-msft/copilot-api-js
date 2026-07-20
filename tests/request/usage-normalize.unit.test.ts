import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  netInputTokens,
  usageFromTotalInput,
} from "~/lib/request/usage-normalize"

// Independent oracle: GHC's `input_tokens = prompt_tokens - cached_tokens`
// (refs/ghc-api-py/ghc_api/translator.py). Expectations are computed by hand,
// NOT by re-deriving from the same code under test.
describe("netInputTokens", () => {
  test("subtracts cache-read from total (GHC oracle: 1000 total, 400 cached → 600 net)", () => {
    expect(netInputTokens(1000, 400)).toBe(600)
  })

  test("subtracts both cache-read and cache-creation", () => {
    expect(netInputTokens(1000, 400, 100)).toBe(500)
  })

  test("floors at 0 when cached exceeds total (defensive)", () => {
    expect(netInputTokens(30, 100)).toBe(0)
  })

  test("defaults cache args to 0 (no cache → total is already net)", () => {
    expect(netInputTokens(500)).toBe(500)
  })
})

describe("usageFromTotalInput", () => {
  test("net input disjoint from cache_read; total recovers to original", () => {
    const u = usageFromTotalInput({ totalInput: 1000, output: 250, cacheRead: 400 })
    expect(u.input_tokens).toBe(600)
    expect(u.cache_read_input_tokens).toBe(400)
    // Invariant: input_tokens + cache_read == the original upstream total (1000).
    expect(u.input_tokens + (u.cache_read_input_tokens ?? 0)).toBe(1000)
  })

  test("omits cache_read when zero", () => {
    const u = usageFromTotalInput({ totalInput: 500, output: 10 })
    expect(u.input_tokens).toBe(500)
    expect(u.cache_read_input_tokens).toBeUndefined()
    expect(u.cache_creation_input_tokens).toBeUndefined()
  })

  test("attaches reasoning only when non-zero", () => {
    expect(usageFromTotalInput({ totalInput: 100, output: 5, reasoning: 0 }).output_tokens_details).toBeUndefined()
    expect(usageFromTotalInput({ totalInput: 100, output: 5, reasoning: 42 }).output_tokens_details).toEqual({ reasoning_tokens: 42 })
  })

  test("carries cache_creation disjointly (Anthropic-shape total = input + read + creation)", () => {
    const u = usageFromTotalInput({ totalInput: 1000, output: 5, cacheRead: 300, cacheCreation: 200 })
    expect(u.input_tokens).toBe(500)
    expect((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)).toBe(1000)
  })
})
