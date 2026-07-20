/**
 * PTY driver：真 TerminalUi，整个 lifetime 持续发编号日志（供 Task 4 数 detail 窗口
 * 内编号连续），lifetime 到点经 ui.destroy() 干净还原退出（Task 3 验 restoreTerminal
 * 的 alt-leave + region.clear() 字节）。harness 用 space→enter 带它进 detail 备用屏。
 */
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

import { diagnostic } from "./diagnostic"

const LIFETIME = Number(process.env.DRIVER_LIFETIME_MS ?? 1500)
const LOG_MS = Number(process.env.DETAIL_LOG_MS ?? 120)

const bus = createBus()
const ui = new TerminalUi(bus, { stdout: process.stdout, stdin: process.stdin, isTTY: true })
const req = bus.scope("request")
const sys = bus.scope("system")

req.publish({
  kind: "request.created",
  ctx: {
    id: "req_pty_detail",
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
  sys.publish(diagnostic(`DETAIL-LOG-${String(n).padStart(4, "0")}`))
}, LOG_MS)

setTimeout(() => {
  clearInterval(timer)
  ui.destroy() // restoreTerminal → alt-leave（若在 detail）+ region.clear()（SHOW_CURSOR）
  process.exit(0)
}, LIFETIME)
