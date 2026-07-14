import { describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"

import { collectGrid, missingNumbers, writeXterm } from "./harness"

describe("pty harness 管线自证", () => {
  test("Bun.Terminal 存在（缺依赖硬 fail 前提）", () => {
    expect(typeof Bun.Terminal).toBe("function")
  })

  test("scrollback oracle 红绿：满编号绿、缺号精确报出", async () => {
    const mk = async (drop: Set<number>): Promise<string> => {
      const term = new Terminal({ cols: 80, rows: 6, scrollback: 2000, allowProposedApi: true, convertEol: true })
      const payload = Array.from({ length: 40 }, (_, i) => i + 1)
        .filter((n) => !drop.has(n))
        .map((n) => `PROBE-LOG-${String(n).padStart(4, "0")}\n`)
        .join("")
      await writeXterm(term, payload)
      const text = collectGrid(term).join("\n")
      term.dispose()
      return text
    }
    expect(missingNumbers(await mk(new Set()), "PROBE-LOG", 40)).toEqual([])
    expect(missingNumbers(await mk(new Set([7, 19, 33])), "PROBE-LOG", 40)).toEqual([7, 19, 33])
  })
})
