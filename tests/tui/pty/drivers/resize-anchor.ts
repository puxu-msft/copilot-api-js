/**
 * PTY driver：真 TerminalUi + 编号日志流，driver **内部 mutable rows source** 驱动 resize
 * 重锚——`rows: () => curRows`（TerminalUiOptions 支持函数式 rows），发满 BURST 条日志后把
 * curRows 从 START_ROWS 改到 NEW_ROWS，下一个 100ms 重绘周期 `Region` 读到新 rows →
 * `geometryChanged` → 走重锚清除分支。**绕开 Bun.Terminal 子进程感知不到 PTY resize 的限制**
 * （`process.stdout.rows` 不刷新、无 SIGWINCH——见 skill bun-node-runtime-gotchas）：这里测的是
 * `Region` 的重锚**逻辑**（rows 变→重锚），不测「PTY resize 通知链路」（那条 Bun 下无法端到端）。
 *
 * 发满后进静默 gap 发 marker，harness 在 gap 内（日志已停）settle 抓中间快照，孤儿行不被覆盖。
 */
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

import { diagnostic } from "./diagnostic"

const BURST = Number(process.env.DRIVER_LOGS ?? 20) // resize 前发的日志条数
const INTERVAL = Number(process.env.DRIVER_MS ?? 50)
const START_ROWS = Number(process.env.DRIVER_START_ROWS ?? 24)
const NEW_ROWS = Number(process.env.DRIVER_NEW_ROWS ?? 30)
const SNAP_MARKER = process.env.SNAP_MARKER ?? "__SNAP__postresize"
const MARKER_AT = Number(process.env.DRIVER_MARKER_MS ?? 600)
const HOLD_MS = Number(process.env.DRIVER_HOLD_MS ?? 800)

let curRows = START_ROWS

const bus = createBus()
const ui = new TerminalUi(bus, { stdout: process.stdout, stdin: process.stdin, isTTY: true, rows: () => curRows })
const req = bus.scope("request")
const sys = bus.scope("system")

req.publish({
  kind: "request.created",
  ctx: {
    id: "req_pty_resize",
    endpoint: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    resolvedModel: "claude-sonnet-4-5",
    state: "streaming",
    startTime: Date.now(),
    queueWaitMs: 0,
  },
} as never)

let n = 0
const timer = setInterval(() => {
  n++
  sys.publish(diagnostic(`RESIZE-LOG-${String(n).padStart(4, "0")}`))
  if (n === BURST - 4) curRows = NEW_ROWS // resize（改注入的 rows source）：让重绘周期读到新 rows → 重锚
  if (n >= BURST) {
    clearInterval(timer)
    // 静默 gap：MARKER_AT 后发 marker（日志已停、孤儿行不被后续滚动覆盖），再 HOLD 后退出。
    setTimeout(() => {
      sys.publish(diagnostic(SNAP_MARKER))
      setTimeout(() => {
        ui.destroy()
        process.exit(0)
      }, HOLD_MS)
    }, MARKER_AT)
  }
}, INTERVAL)
