import { describe, expect, test } from "bun:test"
import { Terminal } from "@xterm/headless"
import fs from "node:fs"
import path from "node:path"

import { collectGrid, missingNumbers, PROJECT_ROOT, writeXterm } from "./harness"

describe("pty harness 管线自证", () => {
  test("Bun.Terminal 存在（缺依赖硬 fail 前提）", () => {
    expect(typeof Bun.Terminal).toBe("function")
  })

  test("driver root follows the current checkout instead of a developer-specific cwd", () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, "package.json"))).toBe(true)
    expect(PROJECT_ROOT).toBe(path.resolve(import.meta.dir, "../../.."))
    expect(PROJECT_ROOT).not.toBe("/home/xp/src/copilot-api-js")
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
