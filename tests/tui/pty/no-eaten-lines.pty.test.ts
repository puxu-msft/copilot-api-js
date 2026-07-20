import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  missingNumbers,
  runDriver,
} from "./harness"

describe("① 不吞行：space 反复切视图时编号日志连续无缺号", () => {
  // 红样本：删 src/lib/tui/render/region.ts:133-137 的 scroll-before-grow →
  // 面板长高时底部日志被覆盖 → missingNumbers 报出缺号。
  // clear() 只擦 panel 区、不擦 scrollback 日志，故读末态 allText 正确。
  test("40 行日志 + 每 200ms space 切视图 → 无缺号（连跑 10 次）", async () => {
    for (let run = 0; run < 10; run++) {
      const keys = Array.from({ length: 15 }, (_, i) => ({ at: 250 + i * 200, bytes: " " }))
      const r = await runDriver({
        driver: "tests/tui/pty/drivers/log-stream.ts",
        env: { DRIVER_LOGS: "40", DRIVER_MS: "40" },
        keys,
      })
      expect(r.exitCode).toBe(0)
      expect(missingNumbers(r.allText, "SELFTEST-LOG", 40)).toEqual([])
    }
  }, 60_000)
})
