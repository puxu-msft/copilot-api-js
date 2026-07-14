import { describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"

import { runDriver, writeXterm } from "./harness"

describe("③ 退出干净还原：从 detail 态退出后回主屏、光标可见、无残留滚动区", () => {
  // 红样本 (a)：删 src/lib/tui/terminal-ui.ts:1142 的 `\x1b[?1049l` → 回不了主屏（buffer.type 非 normal）。
  // 红样本 (b)：删 src/lib/tui/render/region.ts:229 clear() 的 SHOW_CURSOR 或 RESET_SCROLL_REGION →
  //           还原序正则不匹配（光标不还原 / 滚动区不复位）。
  test("space→enter 进 detail 备用屏后退出：字节含 alt进/alt出 + 完整还原序(DECSTBM reset+SHOW_CURSOR) + 重放回主屏", async () => {
    const r = await runDriver({
      driver: "tests/tui/pty/drivers/detail-cycle.ts",
      env: { DRIVER_LIFETIME_MS: "1400" },
      keys: [{ at: 250, bytes: " " }, { at: 500, bytes: "\r" }], // space→panel, enter→detail
    })
    expect(r.exitCode).toBe(0)
    // 备用屏进出只能验原始字节。
    expect(r.rawText).toContain("\x1b[?1049h") // 进过备用屏（真进了 detail）
    expect(r.rawText).toContain("\x1b[?1049l") // 退出回主屏
    // 无残留滚动区 + 光标可见（GPT 收尾审计 HIGH-1）：sentinel 网格落点对「滚动区是否复位」是
    // blind 的（重放到全新 xterm 本就无滚动区），故改验 restoreTerminal 的 region.clear() 必发的
    // 完整还原序 `RESET_SCROLL_REGION(\x1b[r) + cursorTo(\x1b[<row>;1H) + ERASE_TO_END(\x1b[0J) +
    // SHOW_CURSOR(\x1b[?25h)`——删其中 RESET_SCROLL_REGION 或 SHOW_CURSOR 任一段都不匹配。
    expect(r.rawText).toMatch(/\x1b\[r\x1b\[\d+;1H\x1b\[0J\x1b\[\?25h/)
    // 网格重放：验末态回主屏（非备用屏）。
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 2000, allowProposedApi: true })
    await writeXterm(term, r.rawText)
    expect(term.buffer.active.type).toBe("normal") // 回主屏非备用屏
    term.dispose()
  }, 30_000)
})
