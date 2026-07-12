/**
 * PTY self-test driver — REFERENCE TEMPLATE (adapt to your TUI).
 *
 * Runs a REAL interactive TUI (here `TerminalUi`) on the process's real
 * stdin/stdout, which the python harness (pty_grid_test.py) has made a PTY.
 * Publishes a steady stream of numbered log lines + one in-flight request, and
 * honors keyboard input (space toggles collapsed↔panel) exactly like production.
 *
 * TO REUSE IN ANOTHER PROJECT/TUI: swap the two imports + the instantiation +
 * the event source for your own TUI's real wiring. The load-bearing parts are
 * (a) it is the PRODUCTION TUI class on real stdin/stdout (not a mock), (b) it
 * emits ZERO-PADDED numbered lines so the python side can detect eaten lines by
 * missing numbers, (c) it `destroy()`s cleanly so the terminal is restored.
 *
 * Env:
 *   DRIVER_LOGS   number of log lines to emit (default 40)
 *   DRIVER_MS     ms between log lines (default 120)
 */

import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

const TOTAL = Number(process.env.DRIVER_LOGS ?? 40)
const INTERVAL = Number(process.env.DRIVER_MS ?? 120)

const bus = createBus()
// Real interactive instance on the PTY: isTTY + real stdin (setRawMode works).
const ui = new TerminalUi(bus, {
  stdout: process.stdout,
  stdin: process.stdin,
  isTTY: true,
  // read live columns/rows from the PTY
})

const req = bus.scope("request")
const sys = bus.scope("system")

// One long-lived in-flight request so the footer/panel has content and the
// footer timer keeps running (so collapsed renders).
req.publish({
  kind: "request.created",
  ctx: { id: "req_selftest_1", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", resolvedModel: "claude-sonnet-4-5", state: "streaming", startTime: Date.now(), queueWaitMs: 0 },
} as never)

let n = 0
const timer = setInterval(() => {
  n++
  // Zero-padded so pyte substring checks never cross-match (LOG-0007 vs LOG-0070).
  sys.publish({ kind: "system.log", logType: "info", message: `SELFTEST-LOG-${String(n).padStart(4, "0")}`, time: Date.now() } as never)
  if (n >= TOTAL) {
    clearInterval(timer)
    // Give the terminal a beat to flush, then restore + exit cleanly.
    setTimeout(() => {
      ui.destroy()
      process.exit(0)
    }, 150)
  }
}, INTERVAL)
