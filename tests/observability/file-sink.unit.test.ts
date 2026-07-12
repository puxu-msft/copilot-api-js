import {
  //
  afterEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createBus } from "~/lib/observability/bus"
import { FileSink } from "~/lib/observability/sinks/file"
import { TerminalUi } from "~/lib/tui"

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

  test("does not spuriously day-rotate when event days differ from the construction wall-clock", () => {
    // Regression: `currentDay` was seeded from `Date.now()` (construction wall-clock) but
    // compared against each event's embedded `time`. When the logged events' day differs from
    // "today", the FIRST event left `currentDay` stale, so the SECOND same-day event tripped a
    // spurious day-rotation — moving the first line into `.log.1` and losing it from the active
    // file. This test pins a fixed PAST day (always ≠ today), so it would fail under the old
    // behavior on every calendar day except that exact date. Both same-day lines must coexist.
    const logPath = freshLogPath()
    const bus = createBus()
    const sink = new FileSink(bus, { path: logPath })
    const sys = bus.scope("system")
    sys.publish({ kind: "system.log", logType: "info", message: "first same-day", time: Date.parse("2020-01-02T08:00:00") })
    sys.publish({ kind: "system.log", logType: "info", message: "second same-day", time: Date.parse("2020-01-02T08:00:01") })
    sink.destroy()

    const content = fs.readFileSync(logPath, "utf8")
    expect(content).toContain("first same-day")
    expect(content).toContain("second same-day")
    expect(fs.existsSync(`${logPath}.1`)).toBe(false) // no rotation happened
  })

  test("a write failure does not throw (isolated to stderr via emergencyWrite's unregistered fallback)", () => {
    // Point the sink at a path whose parent is a FILE, so mkdir/append fails.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-filesink-"))
    tmpDirs.push(dir)
    const blocker = path.join(dir, "blocker")
    fs.writeFileSync(blocker, "x")
    const badPath = path.join(blocker, "nested", "copilot-api.log")

    const stderrWrite = mock((_s: string | Uint8Array) => true)
    const original = process.stderr.write
    process.stderr.write = stderrWrite as unknown as typeof process.stderr.write

    const bus = createBus()
    const sink = new FileSink(bus, { path: badPath })
    try {
      expect(() => bus.scope("system").publish({ kind: "system.log", logType: "error", message: "boom", time: Date.now() })).not.toThrow()
    } finally {
      process.stderr.write = original
      sink.destroy()
    }

    // No TerminalUi is registered in this test — `emergencyWrite`'s
    // unregistered fallback writes straight to stderr (P2.2, matching the
    // pre-refactor bare `process.stderr.write` behavior). The exact OS error
    // text is platform-dependent (ENOTDIR vs similar), so only pin the
    // `[FileSink] write failed:` prefix + the trailing newline `emergencyWrite`
    // appends.
    expect(stderrWrite).toHaveBeenCalledTimes(1)
    const written = stderrWrite.mock.calls[0][0] as string
    expect(written.startsWith("[FileSink] write failed:")).toBe(true)
    expect(written.endsWith("\n")).toBe(true)
  })

  test("a write failure routes through a registered TerminalUi's coordinator hooks (not a bare stderr write)", () => {
    // Point the sink at a path whose parent is a FILE, so mkdir/append fails.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-filesink-"))
    tmpDirs.push(dir)
    const blocker = path.join(dir, "blocker")
    fs.writeFileSync(blocker, "x")
    const badPath = path.join(blocker, "nested", "copilot-api.log")

    const chunks: Array<string> = []
    const stdout = { write: (s: string) => (chunks.push(s), true), isTTY: false } as unknown as NodeJS.WritableStream
    const bus = createBus()
    const terminal = new TerminalUi(bus, { stdout, isTTY: false }) // non-interactive, no footer → "none" state → write-through

    const sink = new FileSink(bus, { path: badPath })
    expect(() => bus.scope("system").publish({ kind: "system.log", logType: "error", message: "boom", time: Date.now() })).not.toThrow()
    sink.destroy()
    terminal.destroy()

    // Landed on the registered TerminalUi's stdout, not a bare stderr write.
    expect(chunks.join("")).toContain("[FileSink] write failed:")
  })
})
