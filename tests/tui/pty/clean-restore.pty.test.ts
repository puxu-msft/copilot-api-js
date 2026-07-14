import { describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"

import { runDriver, writeXterm } from "./harness"

describe("③ 退出干净还原：从 detail 态退出后回主屏、光标可见、无残留滚动区", () => {
  // 红样本 (a)：删 src/lib/tui/terminal-ui.ts:1142 的 `\x1b[?1049l` → 回不了主屏。
  // 红样本 (b)：改 src/lib/tui/render/region.ts:229，删 clear() 的 SHOW_CURSOR → 光标不还原。
  test("space→enter 进 detail 备用屏后退出：字节含 alt进/alt出/SHOW_CURSOR + 重放末态回主屏且 sentinel 落点正常", async () => {
    const r = await runDriver({
      driver: "tests/tui/pty/drivers/detail-cycle.ts",
      env: { DRIVER_LIFETIME_MS: "1400" },
      keys: [{ at: 250, bytes: " " }, { at: 500, bytes: "\r" }], // space→panel, enter→detail
    })
    expect(r.exitCode).toBe(0)
    // 光标可见性/备用屏进出只能验原始字节。
    expect(r.rawText).toContain("\x1b[?1049h") // 进过备用屏（真进了 detail）
    expect(r.rawText).toContain("\x1b[?1049l") // 退出回主屏
    expect(r.rawText).toContain("\x1b[?25h") // SHOW_CURSOR
    // 网格重放：把还原后的原始字节重放进新 xterm，验回主屏 + 无残留滚动区。
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 2000, allowProposedApi: true })
    await writeXterm(term, r.rawText)
    expect(term.buffer.active.type).toBe("normal") // 回主屏非备用屏
    // 残留滚动区验证（GPT 复审 BLOCK-2）：不用 CUP 绝对定位后查存在（那会绕过残留 DECSTBM）。
    // 改用「自然换行」驱动光标越过旧 scroll-region 底边：若 restoreTerminal 未复位 DECSTBM，
    // 这些换行会被困在旧滚动区内、行不前进；复位正确则 sentinel 落在可见屏末行。
    await writeXterm(term, "\r\n".repeat(30) + "RESTORE-SENTINEL-TAIL")
    const grid: Array<string> = []
    for (let i = 0; i < term.buffer.active.length; i++) grid.push(term.buffer.active.getLine(i)?.translateToString(true) ?? "")
    const visible = grid.slice(-24)
    expect(visible.at(-1) ?? "").toContain("RESTORE-SENTINEL-TAIL")
    term.dispose()
  }, 30_000)
})
