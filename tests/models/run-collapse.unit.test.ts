/**
 * Run-collapse: the token count must be IDENTICAL to encoding for real, and the
 * pathological input must stop costing seconds.
 *
 * Both halves are load-bearing. Speed alone would be satisfied by returning a
 * wrong number instantly, and equality alone was already true before this
 * existed — the bug being fixed is that equality cost 17 seconds on 120KB of
 * whitespace, which blocked the event loop and delayed the shutdown signal
 * (`exp/tokenizer-bench/README.md`).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  collapseLongRuns,
  collapsibleTokens,
  learnBytesPerToken,
} from "~/lib/models/run-collapse"

const encoding = await import("gpt-tokenizer/encoding/o200k_base")
const raw = (text: string): number => encoding.encode(text, { disallowedSpecial: new Set() }).length

const ratios = new Map<string, number | undefined>()
const collapsed = (text: string): number => {
  const { remainder, removedTokens } = collapseLongRuns(text, (run) => {
    if (!ratios.has(run.char)) ratios.set(run.char, learnBytesPerToken(run.char, raw))
    const bytesPerToken = ratios.get(run.char)
    return bytesPerToken === undefined ? { tokens: 0, chars: 0 } : collapsibleTokens(run.length, bytesPerToken)
  })
  return raw(remainder) + removedTokens
}

describe("run-collapse keeps the count exact", () => {
  // The embedded case is the one that caught a real defect: an earlier version removed the
  // whole run, which put `world` next to `goodbye` — an adjacency the input never had — and
  // BPE merged across that new seam, coming out one token short. Keep it.
  test.each([
    ["a run on its own", " ".repeat(60 * 1024)],
    ["a run whose length is not a whole number of tokens", " ".repeat(33333)],
    ["a run embedded between text", `hello world ${" ".repeat(30000)} goodbye world`],
    ["a run whose neighbours do not share its character", `hello world${"=".repeat(30000)}goodbye world`],
    ["several runs of different characters", `abc${"=".repeat(5000)}def${" ".repeat(9000)}ghi`],
    ["a run at the very start", `${" ".repeat(9000)}trailing text`],
    ["a run at the very end", `leading text${" ".repeat(9000)}`],
    ["a run too short to collapse", `${"x".repeat(100)} tail`],
    ["newline and tab runs", `${"\t".repeat(20 * 1024)}\n${"\n".repeat(20 * 1024)}`],
    ["a multi-byte character run", `你好世界${"　".repeat(8000)}再见`],
  ])(
    "%s",
    (_name, text) => {
      expect(collapsed(text)).toBe(raw(text))
      // The oracle is the slow path BY CONSTRUCTION: proving equality means encoding the
      // pathological input for real, which is the 3.5s-per-60KB cost this change exists to
      // avoid. A generous timeout here is not flake tolerance — the assertion is exact
      // equality, and it either holds or it does not.
    },
    120_000,
  )
})

describe("run-collapse removes the quadratic cost", () => {
  test("120KB of whitespace no longer takes seconds", () => {
    const text = " ".repeat(120 * 1024)
    // Warm the probe so this measures the collapse, not the one-time rate learning.
    collapsed(" ".repeat(8192))

    const started = performance.now()
    const count = collapsed(text)
    const elapsed = performance.now() - started

    expect(count).toBe(raw(text))
    // Measured before this change: 17407ms. After: ~1ms. The bound is deliberately
    // three orders of magnitude above the observed value and two below the old one,
    // so it discriminates the regression without being a timing-flake generator.
    expect(elapsed).toBeLessThan(1000)
  }, 120_000)
})
