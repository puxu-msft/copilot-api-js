import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createBus } from "~/lib/observability/bus"
import { FileSink } from "~/lib/observability/sinks/file"

const tmpDirs: Array<string> = []
function freshLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-filesink-"))
  tmpDirs.push(dir)
  return path.join(dir, "copilot-api.log")
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("FileSink ← system.log", () => {
  test("appends non-HTTP logs and strips ANSI color codes", () => {
    const logPath = freshLogPath()
    const bus = createBus()
    const sink = new FileSink(bus, { path: logPath })
    const sys = bus.scope("system")

    sys.publish({ kind: "system.log", logType: "info", message: "plain line", time: Date.parse("2026-06-19T08:09:10") })
    sys.publish({ kind: "system.log", logType: "warn", message: "[33mcolored[39m warning", time: Date.parse("2026-06-19T08:09:11") })
    sink.destroy()

    const content = fs.readFileSync(logPath, "utf8")
    expect(content).toContain("2026-06-19 08:09:10 [INFO] plain line")
    // ANSI stripped:
    expect(content).toContain("2026-06-19 08:09:11 [WARN] colored warning")
    expect(content).not.toContain("[")
  })

  test("ignores non-system.log events (does not duplicate request lines)", () => {
    const logPath = freshLogPath()
    const bus = createBus()
    const sink = new FileSink(bus, { path: logPath })
    // A request.* event must not land in the file (those live in history.db).
    bus.scope("system").publish({ kind: "system.rate_limit_state", mode: "normal", queuedCount: 0 })
    sink.destroy()
    expect(fs.existsSync(logPath)).toBe(false)
  })

  test("rotates by size and retains at most N rotated files", () => {
    const logPath = freshLogPath()
    const bus = createBus()
    // Tiny cap so a few lines trigger rotation; retain 2.
    const sink = new FileSink(bus, { path: logPath, maxSizeBytes: 120, retain: 2 })
    const sys = bus.scope("system")

    for (let i = 0; i < 20; i++) {
      sys.publish({ kind: "system.log", logType: "info", message: `line number ${i} with some padding`, time: Date.parse("2026-06-19T08:00:00") })
    }
    sink.destroy()

    expect(fs.existsSync(logPath)).toBe(true) // active
    expect(fs.existsSync(`${logPath}.1`)).toBe(true)
    expect(fs.existsSync(`${logPath}.2`)).toBe(true)
    // retain=2 → .3 must never exist
    expect(fs.existsSync(`${logPath}.3`)).toBe(false)
  })

  test("rotates across a day boundary", () => {
    const logPath = freshLogPath()
    const bus = createBus()
    const sink = new FileSink(bus, { path: logPath, maxSizeBytes: 10 * 1024 * 1024, retain: 3 })
    const sys = bus.scope("system")

    sys.publish({ kind: "system.log", logType: "info", message: "day one", time: Date.parse("2026-06-19T23:59:59") })
    sys.publish({ kind: "system.log", logType: "info", message: "day two", time: Date.parse("2026-06-20T00:00:01") })
    sink.destroy()

    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toContain("day one")
    expect(fs.readFileSync(logPath, "utf8")).toContain("day two")
  })

  test("a write failure does not throw (isolated to stderr)", () => {
    // Point the sink at a path whose parent is a FILE, so mkdir/append fails.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-filesink-"))
    tmpDirs.push(dir)
    const blocker = path.join(dir, "blocker")
    fs.writeFileSync(blocker, "x")
    const badPath = path.join(blocker, "nested", "copilot-api.log")

    const bus = createBus()
    const sink = new FileSink(bus, { path: badPath })
    expect(() => bus.scope("system").publish({ kind: "system.log", logType: "error", message: "boom", time: Date.now() })).not.toThrow()
    sink.destroy()
  })
})
