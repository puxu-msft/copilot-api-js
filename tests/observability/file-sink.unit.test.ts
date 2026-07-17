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

import { createDiagnosticEvent } from "~/lib/diagnostics"
import { createBus } from "~/lib/observability/bus"
import { FileSink } from "~/lib/observability/sinks/file"
import { TerminalUi } from "~/lib/tui"

const tmpDirs: Array<string> = []

function freshLogPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-filesink-"))
  tmpDirs.push(dir)
  return path.join(dir, "copilot-api.log")
}

function publishDiagnostic(bus: ReturnType<typeof createBus>, level: "info" | "warn" | "error", message: string, timeUnixMs: number): void {
  bus.scope("system").publish({
    kind: "system.diagnostic",
    diagnostic: createDiagnosticEvent({ level, event: "test.file", message, timeUnixMs, origin: "native" }),
  })
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("FileSink ? system.diagnostic", () => {
  test("appends non-HTTP logs and strips ANSI color codes", () => {
    const logPath = freshLogPath()
    const bus = createBus()
    const sink = new FileSink(bus, { path: logPath })

    publishDiagnostic(bus, "info", "plain line", Date.parse("2026-06-19T08:09:10"))
    publishDiagnostic(bus, "warn", "\u001b[33mcolored\u001b[39m warning", Date.parse("2026-06-19T08:09:11"))
    sink.destroy()

    const content = fs.readFileSync(logPath, "utf8")
    expect(content).toContain("2026-06-19 08:09:10 [INFO] plain line")
    expect(content).toContain("2026-06-19 08:09:11 [WARN] colored warning")
    expect(content).not.toContain("\u001b[")
  })

  test("ignores unrelated system events", () => {
    const logPath = freshLogPath()
    const bus = createBus()
    const sink = new FileSink(bus, { path: logPath })
    bus.scope("system").publish({ kind: "system.rate_limit_state", mode: "normal", queuedCount: 0 })
    sink.destroy()
    expect(fs.existsSync(logPath)).toBe(false)
  })

  test("rotates by size and retains at most N rotated files", () => {
    const logPath = freshLogPath()
    const bus = createBus()
    const sink = new FileSink(bus, { path: logPath, maxSizeBytes: 120, retain: 2 })
    for (let i = 0; i < 20; i++) publishDiagnostic(bus, "info", `line number ${i} with some padding`, Date.parse("2026-06-19T08:00:00"))
    sink.destroy()

    expect(fs.existsSync(logPath)).toBe(true)
    expect(fs.existsSync(`${logPath}.1`)).toBe(true)
    expect(fs.existsSync(`${logPath}.2`)).toBe(true)
    expect(fs.existsSync(`${logPath}.3`)).toBe(false)
  })

  test("rotates across a day boundary", () => {
    const logPath = freshLogPath()
    const bus = createBus()
    const sink = new FileSink(bus, { path: logPath, maxSizeBytes: 10 * 1024 * 1024, retain: 3 })
    publishDiagnostic(bus, "info", "day one", Date.parse("2026-06-19T23:59:59"))
    publishDiagnostic(bus, "info", "day two", Date.parse("2026-06-20T00:00:01"))
    sink.destroy()

    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toContain("day one")
    expect(fs.readFileSync(logPath, "utf8")).toContain("day two")
  })

  test("does not spuriously day-rotate when event days differ from construction time", () => {
    const logPath = freshLogPath()
    const bus = createBus()
    const sink = new FileSink(bus, { path: logPath })
    publishDiagnostic(bus, "info", "first same-day", Date.parse("2020-01-02T08:00:00"))
    publishDiagnostic(bus, "info", "second same-day", Date.parse("2020-01-02T08:00:01"))
    sink.destroy()

    const content = fs.readFileSync(logPath, "utf8")
    expect(content).toContain("first same-day")
    expect(content).toContain("second same-day")
    expect(fs.existsSync(`${logPath}.1`)).toBe(false)
  })

  test("a write failure does not throw", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-filesink-"))
    tmpDirs.push(dir)
    const blocker = path.join(dir, "blocker")
    fs.writeFileSync(blocker, "x")
    const bus = createBus()
    const sink = new FileSink(bus, { path: path.join(blocker, "nested", "copilot-api.log") })
    expect(() => publishDiagnostic(bus, "error", "boom", Date.now())).not.toThrow()
    sink.destroy()
  })

  test("a write failure routes through a registered TerminalUi coordinator", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-filesink-"))
    tmpDirs.push(dir)
    const blocker = path.join(dir, "blocker")
    fs.writeFileSync(blocker, "x")
    const chunks: Array<string> = []
    const stdout = { write: (s: string) => (chunks.push(s), true), isTTY: false } as unknown as NodeJS.WritableStream
    const bus = createBus()
    const terminal = new TerminalUi(bus, { stdout, isTTY: false })
    const sink = new FileSink(bus, { path: path.join(blocker, "nested", "copilot-api.log") })
    expect(() => publishDiagnostic(bus, "error", "boom", Date.now())).not.toThrow()
    sink.destroy()
    terminal.destroy()
    expect(chunks.join("")).toContain("[FileSink] write failed:")
  })
})
