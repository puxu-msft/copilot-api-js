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

describe("④ 切 detail 不覆盖底部日志：detail 期间日志退出后完整回放", () => {
  // 红样本：删 src/lib/tui/terminal-ui.ts:1103 的 flushReplayQueue() →
  // detail 备用屏期间 printLog 排队的日志不回放 → scrollback 缺 detail 窗口编号段。
  test("detail 停留期间的日志（窗口内编号段）退出后无缺号（连跑 10 次）", async () => {
    for (let run = 0; run < 10; run++) {
      const r = await runDriver({
        driver: "tests/tui/pty/drivers/detail-cycle.ts",
        env: { DRIVER_LIFETIME_MS: "2000", DETAIL_LOG_MS: "100" },
        keys: [
          { at: 500, bytes: " " }, // panel
          { at: 700, bytes: "\r" }, // detail（第 ~7 条后进入）
          { at: 1500, bytes: "\x1b" }, // escape 回 panel（触发 flushReplayQueue）
        ],
      })
      expect(r.exitCode).toBe(0)
      // 前置断言（GPT 复审 HIGH-2）：必须真进/出备用屏，否则日志全直写、红样本假绿。
      expect(r.rawText).toContain("\x1b[?1049h") // 真进了 detail
      expect(r.rawText).toContain("\x1b[?1049l") // 真退出 detail
      // detail 窗口 = 700–1500ms，每 100ms 一条 → 第 8–15 条确在 detail 内产生（排队→回放）。
      // 只断言这段无缺号（进 detail 前的第 1–7 条不参与红样本，删 flush 不影响它们）。
      const missing = missingNumbers(r.allText, "DETAIL-LOG", 20).filter((n) => n >= 8 && n <= 15)
      expect(missing).toEqual([])
    }
  }, 60_000)
})
