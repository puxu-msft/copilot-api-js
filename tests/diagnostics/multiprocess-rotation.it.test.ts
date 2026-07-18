import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

test("two per-process structured writers rotate concurrently for 25 rounds with exactly-once records", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-multiprocess-"))
  dirs.push(directory)
  const fixture = path.join(import.meta.dir, "fixtures", "multiprocess-structured-writer.ts")
  const count = 100
  for (let round = 0; round < 25; round++) {
    const prefixes = [`r${round}-a`, `r${round}-b`]
    const children = prefixes.map((prefix) =>
      Bun.spawn(["bun", fixture, directory, prefix, String(count)], { cwd: path.resolve(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" }),
    )
    const exits = await Promise.all(children.map((child) => child.exited))
    expect(exits).toEqual([0, 0])
  }

  const found = new Map<string, number>()
  const segments = fs.readdirSync(directory).filter((item) => item.endsWith(".ndjson"))
  expect(segments.length).toBeGreaterThan(25 * 2)
  for (const name of segments) {
    for (const line of fs.readFileSync(path.join(directory, name), "utf8").split("\n").filter(Boolean)) {
      const parsed = JSON.parse(line) as { record?: { diagnostic?: { event?: string; message?: string } } }
      if (parsed.record?.diagnostic?.event === "multiprocess" && parsed.record.diagnostic.message) {
        const message = parsed.record.diagnostic.message
        found.set(message, (found.get(message) ?? 0) + 1)
      }
    }
  }
  expect(found.size).toBe(25 * 2 * count)
  expect([...found.values()].every((occurrences) => occurrences === 1)).toBe(true)
}, 120_000)
