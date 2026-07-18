import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ActiveRequest } from "~/lib/tui/active-request-store"

import { createDiagnosticEvent } from "~/lib/diagnostics"
import { buildActiveFooter } from "~/lib/tui/render/footer"
import { renderRequestEffect } from "~/lib/tui/render/lifecycle"
import {
  //
  buildDetailLines,
  buildPanelLines,
} from "~/lib/tui/render/panel"
import { renderSystemLogLine } from "~/lib/tui/render/syslog"

const ESC = "\u001b"
const HOSTILE = `${ESC}]8;;https://bad.invalid\u0007link${ESC}]8;;\u0007${ESC}]52;c;secret\u0007${ESC}Ppayload${ESC}\\${ESC}[2J\u009b31m\u0007\r\nnext`

function active(): ActiveRequest {
  return {
    ctx: {
      id: `req-${HOSTILE}`,
      endpoint: "anthropic-messages",
      method: "POST",
      path: `/v1/${HOSTILE}`,
      clientModel: HOSTILE,
      resolvedModel: HOSTILE,
      state: "streaming",
      startTime: 0,
      queueWaitMs: 0,
    },
    tags: [HOSTILE],
    isHistoryAccess: false,
    attemptCount: 1,
    attempts: [{ attemptIndex: 0, strategy: HOSTILE, error: { status: 500, type: HOSTILE, message: HOSTILE } }],
  }
}

function expectSafe(text: string): void {
  expect(text).not.toContain("secret")
  expect(text).not.toContain("payload")
  expect(text).not.toContain("https://bad.invalid")
  expect(text).not.toContain("\u009b")
  expect(text).not.toContain("\r")
  expect(text).not.toContain("\n")
}

describe("terminal sanitizer coverage", () => {
  test("request lifecycle and system diagnostics sanitize all external fields", () => {
    const entry = active()
    const created = renderRequestEffect({ kind: "created", entry }, { now: 1000, showActive: true, verbose: true, ordinalFor: () => undefined })!
    const diagnostic = renderSystemLogLine(createDiagnosticEvent({ level: "warn", event: "hostile", message: HOSTILE, origin: "native" }))
    expectSafe(created)
    expectSafe(diagnostic)
  })

  test("footer, panel, and detail sanitize external request projections", () => {
    const entry = active()
    expectSafe(buildActiveFooter({ active: [entry], now: 1000, columns: 300 }))
    const panel = buildPanelLines({ active: [entry], now: 1000, columns: 300, selectedIndex: 0, scrollOffset: 0, rows: 10, showHelp: false }).join("\n")
    const detail = buildDetailLines({ entry, now: 1000, columns: 300 }).join("\n")
    expectSafe(panel.replaceAll("\n", ""))
    expectSafe(detail.replaceAll("\n", ""))
    expect(panel).toContain("\u001b[7m")
    expect(panel).toContain("\u001b[27m")
  })
})
