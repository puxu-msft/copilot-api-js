import { describe, expect, test } from "bun:test"

import { runDriver } from "./harness"

const PANEL_ROWS = 3 // TerminalUi panel 恒高 min(rows,3)；footer 内容在该区首行，余为 padding。

describe("② footer/panel 钉底：footer 内容在末 panel 区、滚动日志在其上", () => {
  // 红样本：改 src/lib/tui/render/region.ts:186 的 panelTop（如 `rows - panelHeight - 1`）→
  // panel 画到非物理末区 → footer 不在末 PANEL_ROWS 区 / 日志侵入该区。
  // 用 SNAP_MARKER 握手快照读 driver 未 destroy(clear) 前的网格（末态 footer 已被擦）。
  test("进 panel 后运行中快照：footer 在末 panel 区、日志不在该区（连跑 10 次）", async () => {
    for (let run = 0; run < 10; run++) {
      const r = await runDriver({
        driver: "tests/tui/pty/drivers/log-stream.ts",
        env: { DRIVER_LOGS: "50", DRIVER_MS: "50", SNAP_MARKER: "__SNAP__panel" },
        keys: [{ at: 250, bytes: " " }], // 进 panel，不再切回
        snapshots: [{ marker: "__SNAP__panel", label: "panel" }], // 握手：抓运行中快照
        rows: 24,
      })
      expect(r.exitCode).toBe(0)
      const snap = r.snapshots["panel"]
      expect(snap).toBeDefined() // 握手成功（marker 抓到快照）
      const visible = snap!.slice(-24)
      const panelZone = visible.slice(-PANEL_ROWS) // 末 3 行 = panel 区
      const aboveZone = visible.slice(0, -PANEL_ROWS)
      // footer 内容（在途 request 的 model 名）在 panel 区，不在其上的滚动区。
      expect(panelZone.some((l) => l.includes("claude-sonnet-4-5"))).toBe(true)
      expect(aboveZone.some((l) => l.includes("claude-sonnet-4-5"))).toBe(false)
      // 滚动日志在 panel 区之上，不侵入 panel 区。
      expect(panelZone.some((l) => l.includes("SELFTEST-LOG"))).toBe(false)
      expect(aboveZone.some((l) => l.includes("SELFTEST-LOG"))).toBe(true)
    }
  }, 90_000)
})
