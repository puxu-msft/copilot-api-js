import { describe, expect, test } from "bun:test"

import { missingNumbers, runDriver } from "./harness"

const OBSERVE_ROWS = 40 // 固定大观察窗口 > 所有 resize 目标，避开 xterm.resize reflow 丢行。

describe("⑤ resize 重锚：rows 变化时 Region 重锚、旧 panel 无孤儿行", () => {
  // driver 内部用注入的 mutable rows source（`rows: () => curRows`）驱动 resize，绕开 Bun.Terminal
  // 子进程感知不到 PTY resize 的限制（见 skill bun-node-runtime-gotchas）——测的是 Region 的重锚
  // 逻辑（rows 变→geometryChanged→重锚清除），非 PTY resize 通知链路（Bun 下无法端到端）。
  //
  // 红样本：注释 src/lib/tui/render/region.ts:138-145 的 RESET_SCROLL_REGION + 清旧 panel 行 →
  // resize 后旧 panel footer 成孤儿残留 → 快照里出现第二个 footer（footerCount > 1）。
  test("rows 24→30 后中间快照：无孤儿行(footerCount===1) + 日志无缺号（连跑 10 次）", async () => {
    for (let run = 0; run < 10; run++) {
      const r = await runDriver({
        driver: "tests/tui/pty/drivers/resize-anchor.ts",
        env: { DRIVER_LOGS: "20", DRIVER_MS: "50", DRIVER_START_ROWS: "24", DRIVER_NEW_ROWS: "30" },
        rows: OBSERVE_ROWS, // xterm 固定大观察窗口（PTY 不 resize，rows 变化在 driver 内部）
        snapshots: [{ marker: "__SNAP__postresize", label: "postresize" }],
        timeoutMs: 10_000,
      })
      expect(r.exitCode).toBe(0)
      // resize 前的日志不吞（连续）。
      expect(missingNumbers(r.allText, "RESIZE-LOG", 20)).toEqual([])
      const snap = r.snapshots["postresize"]
      expect(snap).toBeDefined()
      // 孤儿行断言：整快照只有一个 footer（重锚后的新底），无 resize 遗留的旧 footer。
      const footerRows = snap!.filter((l) => l.includes("claude-sonnet-4-5"))
      expect(footerRows.length).toBe(1)
    }
  }, 90_000)
})
