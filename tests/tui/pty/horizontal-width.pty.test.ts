import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { runDriver } from "./harness"

function requestRow(result: Awaited<ReturnType<typeof runDriver>>, label: string) {
  const rows = result.snapshotRows[label]
  expect(rows).toBeDefined()
  const row = rows.find((candidate) => candidate.text.includes("req_"))
  expect(row).toBeDefined()
  return row!
}

describe("⑥ 水平宽度：复杂字素不拆分、不自动换行、columns 动态重算", () => {
  test("固定 7 列下国旗字素不拆半，panel 行占用 ≤ columns-1 且不 wrap（连跑 8 次）", async () => {
    for (let run = 0; run < 8; run++) {
      const result = await runDriver({
        driver: "tests/tui/pty/drivers/width-resize.ts",
        cols: 7,
        rows: 8,
        env: { DRIVER_START_COLUMNS: "7", DRIVER_NEW_COLUMNS: "7", SNAP_MARKER: "__WIDTH_FIXED__" },
        keys: [{ at: 150, bytes: " " }],
        snapshots: [{ marker: "__WIDTH_FIXED__", label: "fixed" }],
      })
      expect(result.exitCode).toBe(0)
      const row = requestRow(result, "fixed")
      expect(row.text).toContain("req_…")
      expect(row.text).not.toContain("🇨")
      expect(row.occupiedColumns).toBeLessThanOrEqual(6)
      expect(row.isWrapped).toBe(false)
    }
  }, 30_000)

  test("注入 columns 30→7 后，下一次生产重绘采用新宽度（连跑 8 次）", async () => {
    for (let run = 0; run < 8; run++) {
      const result = await runDriver({
        driver: "tests/tui/pty/drivers/width-resize.ts",
        cols: 30,
        rows: 8,
        env: { DRIVER_START_COLUMNS: "30", DRIVER_NEW_COLUMNS: "7", SNAP_MARKER: "__WIDTH_RESIZED__" },
        keys: [{ at: 150, bytes: " " }],
        snapshots: [{ marker: "__WIDTH_RESIZED__", label: "resized" }],
      })
      expect(result.exitCode).toBe(0)
      const row = requestRow(result, "resized")
      expect(row.text).toContain("req_…")
      expect(row.text).not.toContain("🇨")
      expect(row.occupiedColumns).toBeLessThanOrEqual(6)
      expect(row.isWrapped).toBe(false)
    }
  }, 30_000)
})
