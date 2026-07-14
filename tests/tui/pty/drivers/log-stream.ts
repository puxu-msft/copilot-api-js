/**
 * PTY driver：真 TerminalUi + 一个 in-flight request + 编号日志流 + space 切视图。
 * 收到 space 进 panel 时（若 env SNAP_MARKER 设）额外发一条 marker 日志，供 harness 抓
 * 运行中快照。提升自 exp/tui-rawmode/pty_selftest_driver.ts。
 */
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

const TOTAL = Number(process.env.DRIVER_LOGS ?? 40)
const INTERVAL = Number(process.env.DRIVER_MS ?? 60)
const SNAP_MARKER = process.env.SNAP_MARKER // 例："__SNAP__panel"

const bus = createBus()
const ui = new TerminalUi(bus, { stdout: process.stdout, stdin: process.stdin, isTTY: true })
const req = bus.scope("request")
const sys = bus.scope("system")

req.publish({
  kind: "request.created",
  ctx: { id: "req_pty_1", endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", resolvedModel: "claude-sonnet-4-5", state: "streaming", startTime: Date.now(), queueWaitMs: 0 },
} as never)

// SNAP_MARKER：进 panel 稳定后（给切视图 + 重绘留时间）发一条 marker 日志。
if (SNAP_MARKER) {
  setTimeout(() => sys.publish({ kind: "system.log", logType: "info", message: SNAP_MARKER, time: Date.now() } as never), 900)
}

let n = 0
const timer = setInterval(() => {
  n++
  sys.publish({ kind: "system.log", logType: "info", message: `SELFTEST-LOG-${String(n).padStart(4, "0")}`, time: Date.now() } as never)
  if (n >= TOTAL) {
    clearInterval(timer)
    setTimeout(() => {
      ui.destroy()
      process.exit(0)
    }, 150)
  }
}, INTERVAL)
