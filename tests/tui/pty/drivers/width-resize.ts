/** 真 TerminalUi 水平宽度 driver：复杂 Unicode id + 可变 columns source。 */
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

import { diagnostic } from "./diagnostic"

const START_COLUMNS = Number(process.env.DRIVER_START_COLUMNS ?? 30)
const NEW_COLUMNS = Number(process.env.DRIVER_NEW_COLUMNS ?? START_COLUMNS)
const SNAP_MARKER = process.env.SNAP_MARKER ?? "__WIDTH_SNAP__"
const RESIZE_AT_MS = Number(process.env.DRIVER_RESIZE_AT_MS ?? 350)
const MARKER_AT_MS = Number(process.env.DRIVER_MARKER_AT_MS ?? 600)
const EXIT_AT_MS = Number(process.env.DRIVER_EXIT_AT_MS ?? 1200)

let columns = START_COLUMNS
const bus = createBus()
const ui = new TerminalUi(bus, { stdout: process.stdout, stdin: process.stdin, isTTY: true, columns: () => columns })

bus.scope("request").publish({
  kind: "request.created",
  ctx: {
    id: "req_🇨🇳x",
    endpoint: "anthropic-messages",
    method: "POST",
    path: "/v1/1️⃣🇨🇳👍🏽/messages",
    resolvedModel: "模型-🇨🇳",
    state: "streaming",
    startTime: Date.now(),
    queueWaitMs: 0,
  },
} as never)

setTimeout(() => {
  columns = NEW_COLUMNS
}, RESIZE_AT_MS)
setTimeout(() => bus.scope("system").publish(diagnostic(SNAP_MARKER)), MARKER_AT_MS)
setTimeout(() => {
  ui.destroy()
  process.exit(0)
}, EXIT_AT_MS)
