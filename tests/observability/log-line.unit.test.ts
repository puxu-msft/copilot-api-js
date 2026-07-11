/**
 * `formatLogLine` — the canonical request-history line shape shared by the
 * TerminalUi renderer and its `render/` helpers.
 *
 * These tests pin the token column + cache-rate marker that surface on
 * completion lines: `↑<in>+<cacheRead>+<cacheCreation> ↓<out> ↻<hit%>+<new%>`.
 * Color is stripped so assertions target the plain rendered text; a separate
 * `format.unit.test.ts` block pins the dim/cyan coloring of the marker itself.
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

  test("cache breakdown and rate marker follow the token column", () => {
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
    // token column carries the +read+creation breakdown, then the ↻ marker.
    expect(line).toContain("↑1.0k+8.0k+1.0k ↓456 ↻80%+10%")
  })

  test("marker is omitted when there is no cache activity", () => {
    const line = stripAnsi(formatLogLine(okParts({ inputTokens: 1200, outputTokens: 456 })))
    expect(line).not.toContain("↻")
    expect(line).toContain("↑1.2k ↓456")
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
