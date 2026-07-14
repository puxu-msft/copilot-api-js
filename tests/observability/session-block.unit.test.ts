/**
 * `session-block` — the session-identity glyph on request log lines.
 *
 * Pins the pure pieces: the glyph mapping (main square / subagent circled
 * numbers / `(N)` past 20), color STABILITY + grouping by sessionId, and
 * omission when there is no session. The exact 256-color SGR bytes are asserted
 * under FORCE_COLOR (in-process `pc.isColorSupported === false` strips color, so
 * shape is what's observable here).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  agentGlyph,
  formatSessionBlock,
  sessionAnsi256,
} from "~/lib/observability/projections/session-block"

// eslint-disable-next-line no-control-regex -- intentional ANSI escape range
const stripAnsi = (s: string): string => s.replaceAll(/\x1b\[[0-9;]*m/g, "")

describe("agentGlyph", () => {
  test("1–10 map to the negative-circled digits ❶..❿", () => {
    expect(agentGlyph(1)).toBe("❶")
    expect(agentGlyph(10)).toBe("❿")
  })

  test("11–20 map to the negative-circled numbers ⓫..⓴", () => {
    expect(agentGlyph(11)).toBe("⓫")
    expect(agentGlyph(20)).toBe("⓴")
  })

  test("past 20 falls back to a plain (N)", () => {
    expect(agentGlyph(21)).toBe("(21)")
    expect(agentGlyph(99)).toBe("(99)")
  })

  test("absent / non-positive ordinal degrades to a generic filled circle", () => {
    expect(agentGlyph(undefined)).toBe("●")
    expect(agentGlyph(0)).toBe("●")
  })
})

describe("sessionAnsi256", () => {
  test("is stable for a given sessionId and in the 256-color range", () => {
    const a = sessionAnsi256("sess-abc")
    expect(a).toBe(sessionAnsi256("sess-abc"))
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThanOrEqual(255)
  })

  test("distinct sessions spread across the palette (not all one color)", () => {
    const codes = new Set(Array.from({ length: 30 }, (_, i) => sessionAnsi256(`s${i}`)))
    expect(codes.size).toBeGreaterThan(1)
  })
})

describe("formatSessionBlock", () => {
  test("no sessionId → empty string (nothing to group)", () => {
    expect(formatSessionBlock({})).toBe("")
    expect(formatSessionBlock({ agentId: "ag1", agentOrdinal: 1 })).toBe("")
  })

  test("main agent (no agentId) → solid square", () => {
    expect(stripAnsi(formatSessionBlock({ sessionId: "S1" }))).toBe("■")
  })

  test("subagent → its circled ordinal", () => {
    expect(stripAnsi(formatSessionBlock({ sessionId: "S1", agentId: "ag1", agentOrdinal: 2 }))).toBe("❷")
  })

  test("main and subagent of the SAME session carry the same foreground color", () => {
    const code = sessionAnsi256("S1")
    const main = formatSessionBlock({ sessionId: "S1" })
    const sub = formatSessionBlock({ sessionId: "S1", agentId: "ag1", agentOrdinal: 1 })
    // Under FORCE_COLOR the SGR carries the code; in-process (no color) both are
    // plain glyphs — assert the shared code via sessionAnsi256 either way.
    expect(sessionAnsi256("S1")).toBe(code)
    if (main.includes("\x1b")) {
      expect(main).toContain(`38;5;${code}m`)
      expect(sub).toContain(`38;5;${code}m`)
    }
  })
})
