/**
 * `formatLogLine` — the canonical request-history line shape shared by the
 * TerminalUi renderer and its `render/` helpers.
 *
 * These tests pin the token column + cache-rate marker that surface on
 * completion lines: `↑<in>+<cacheRead>+<cacheCreation> ↻<hit%>+<new%> ↓<out>`,
 * plus the severity-colored duration. Color is stripped for text-shape
 * assertions; the `format.unit.test.ts` block pins the marker/duration colors
 * themselves, and one test here checks duration gets `durationColor(durationMs)`.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { LogLineParts } from "~/lib/observability/projections/log-line"

import { formatLogLine } from "~/lib/observability/projections/log-line"

// eslint-disable-next-line no-control-regex -- intentional ANSI escape range
const stripAnsi = (s: string): string => s.replaceAll(/\x1b\[[0-9;]*m/g, "")

/** Minimal successful-completion parts; per-test overrides layer on top. */
function okParts(over: Partial<LogLineParts> = {}): LogLineParts {
  return {
    prefix: "[ OK ]",
    time: "12:34:56",
    method: "POST",
    path: "/v1/messages",
    model: "claude-opus-4-8",
    status: 200,
    duration: "1.2s",
    ...over,
  }
}

describe("formatLogLine — token column + cache-rate marker", () => {
  test("token counts render with a lowercase 'k' unit", () => {
    const line = stripAnsi(formatLogLine(okParts({ inputTokens: 1000, outputTokens: 456 })))
    expect(line).toContain("↑1.0k ↓456")
  })

  test("cache breakdown and rate marker sit between the input group and ↓output", () => {
    const line = stripAnsi(
      formatLogLine(
        okParts({
          inputTokens: 1000,
          outputTokens: 456,
          cacheReadInputTokens: 8000,
          cacheCreationInputTokens: 1000,
        }),
      ),
    )
    // ↑input+read+creation, then the ↻ marker, then ↓output (cache is input-side).
    expect(line).toContain("↑1.0k+8.0k+1.0k ↻80%+10% ↓456")
  })

  test("marker is omitted when there is no cache activity", () => {
    const line = stripAnsi(formatLogLine(okParts({ inputTokens: 1200, outputTokens: 456 })))
    expect(line).not.toContain("↻")
    expect(line).toContain("↑1.2k ↓456")
  })

  test("↓output is omitted when output is not applicable (undefined), but ↓0 shows for a measured zero", () => {
    // count_tokens counts input only (no completion) → outputTokens undefined → no ↓ column.
    const noOutput = stripAnsi(formatLogLine(okParts({ inputTokens: 21, outputTokens: undefined })))
    expect(noOutput).toContain("↑21")
    expect(noOutput).not.toContain("↓")
    // A real request that genuinely produced 0 output still shows ↓0 (measured zero).
    const zeroOutput = stripAnsi(formatLogLine(okParts({ inputTokens: 21, outputTokens: 0 })))
    expect(zeroOutput).toContain("↑21 ↓0")
  })

  test("neither token column nor marker render without a resolved model", () => {
    const line = stripAnsi(
      formatLogLine({
        prefix: "[ OK ]",
        time: "12:34:56",
        method: "POST",
        path: "/v1/messages",
        status: 200,
        inputTokens: 1000,
        cacheReadInputTokens: 8000,
      }),
    )
    expect(line).not.toContain("↑")
    expect(line).not.toContain("↻")
  })

  test("dim (start/history) lines never carry the token column or marker", () => {
    const line = stripAnsi(
      formatLogLine(
        okParts({
          isDim: true,
          inputTokens: 1000,
          cacheReadInputTokens: 8000,
          cacheCreationInputTokens: 1000,
        }),
      ),
    )
    expect(line).not.toContain("↻")
    expect(line).not.toContain("↑1.0k")
  })
})

describe("formatLogLine — duration rendering", () => {
  // The duration *text* is asserted here (env-independent); the severity COLOR
  // routing (durationMs → durationColor vs the plain-yellow fallback) can only
  // be observed with color enabled, so it is proven in the FORCE_COLOR
  // integration test (tests/tui/log-line-color.integration.test.ts) — under
  // bun's `pc.isColorSupported === false` all colors collapse to identity.
  test("the duration string is rendered whether or not durationMs is supplied", () => {
    expect(stripAnsi(formatLogLine(okParts({ duration: "200.0s", durationMs: 200_000 })))).toContain("200.0s")
    expect(stripAnsi(formatLogLine(okParts({ duration: "1.2s", durationMs: undefined, isRetry: true })))).toContain("1.2s")
  })
})

describe("formatLogLine — stop_reason token", () => {
  test("renders as a `⇥<reason>` token when supplied", () => {
    expect(stripAnsi(formatLogLine(okParts({ stopReason: "end_turn" })))).toContain("⇥end_turn")
    expect(stripAnsi(formatLogLine(okParts({ stopReason: "tool_use" })))).toContain("⇥tool_use")
    expect(stripAnsi(formatLogLine(okParts({ stopReason: "max_tokens" })))).toContain("⇥max_tokens")
  })

  test("is omitted entirely when no stop_reason is supplied", () => {
    expect(stripAnsi(formatLogLine(okParts()))).not.toContain("⇥")
  })

  test("sits after the token counts and before the feature tags (grey parens stay last)", () => {
    const line = stripAnsi(formatLogLine(okParts({ inputTokens: 1200, outputTokens: 200, extra: " (thinking)", stopReason: "tool_use" })))
    // Order: ↓output → ⇥stopReason → grey tags.
    expect(line.indexOf("↓200")).toBeLessThan(line.indexOf("⇥tool_use"))
    expect(line.indexOf("⇥tool_use")).toBeLessThan(line.indexOf("(thinking)"))
  })

  test("dim (start/history) lines never carry the stop_reason token", () => {
    expect(stripAnsi(formatLogLine(okParts({ isDim: true, stopReason: "end_turn" })))).not.toContain("⇥")
  })
})
