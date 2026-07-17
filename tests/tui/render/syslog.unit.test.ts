/**
 * `renderSystemLogLine` — pure system.log line renderer (extracted from
 * ConsoleSink's `onSystemLog` + private `consolaPrefix` in the P0 terminal-layer
 * reorg).
 *
 * These assert the same prefix/formatting behavior pinned end-to-end by
 * `tests/observability/console-system-log.unit.test.ts`, but directly against
 * the pure function instead of driving it through the sink's republish plumbing:
 *
 *   - each `logType` maps to its fixed `[XXXX]` badge (info→INFO, warn→WARN,
 *     error/fatal→ERR, success→SUCC, debug→DBG); an unknown type yields the bare
 *     timestamp with no badge;
 *   - the rendered line carries the normalized HH:MM:SS stamp from the event's
 *     own `time` and ends with the message (no trailing newline).
 *
 * ANSI note: picocolors emits color codes when stdout is a TTY. To keep these
 * assertions robust regardless of the runner's TTY state, we strip ANSI escapes
 * before matching on the visible badge/text.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { DiagnosticLevel } from "~/lib/diagnostics"

import { renderSystemLogLine } from "~/lib/tui/render/syslog"

const NOW = new Date("2023-11-14T14:25:36").getTime()

/** Strip ANSI SGR escapes so assertions match visible text regardless of TTY. */
// eslint-disable-next-line no-control-regex -- intentional ANSI escape range
const stripAnsi = (s: string): string => s.replaceAll(/\x1b\[[0-9;]*m/g, "")

describe("renderSystemLogLine (system.log pure renderer)", () => {
  test("info → [INFO] badge, normalized time, and message", () => {
    const line = stripAnsi(renderSystemLogLine({ severity: "info", message: "hi", timeUnixMs: NOW }))
    expect(line.startsWith("[INFO] ")).toBe(true)
    expect(line).toContain("14:25:36")
    expect(line.endsWith(" hi")).toBe(true)
    // Full byte-exact shape: `[INFO] HH:MM:SS message`.
    expect(line).toBe("[INFO] 14:25:36 hi")
  })

  test("each logType maps to its fixed badge", () => {
    const cases: Array<[DiagnosticLevel | "success", string]> = [
      ["error", "[ERR ]"],
      ["fatal", "[ERR ]"],
      ["warn", "[WARN]"],
      ["info", "[INFO]"],
      ["success", "[SUCC]"],
      ["debug", "[DBG ]"],
    ]
    for (const [logType, badge] of cases) {
      const line = stripAnsi(renderSystemLogLine({ severity: logType, message: "m", timeUnixMs: NOW }))
      expect(line).toBe(`${badge} 14:25:36 m`)
    }
  })

  test("unknown logType → bare timestamp prefix (no badge)", () => {
    const line = stripAnsi(renderSystemLogLine({ severity: "trace", message: "m", timeUnixMs: NOW }))
    expect(line).toBe("14:25:36 m")
  })
})
