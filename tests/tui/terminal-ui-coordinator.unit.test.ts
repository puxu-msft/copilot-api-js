/**
 * P2.2 — `TerminalUi` registers itself with `terminal-coordinator` (P2.1),
 * supplying the `state`/`clearPanel`/`redrawPanel`/`write` hooks so
 * `emergencyWrite` (republish.ts's reentrant fallback, FileSink's write-failure
 * fallback — wired in this same task) can reach the terminal without
 * corrupting whatever this instance is currently drawing at the bottom of the
 * screen.
 *
 * These pins drive the real `bus → TerminalUi` path plus the coordinator's
 * public `emergencyWrite` (not internal hook plumbing) so the assertions
 * exercise the actual registration contract, not a reimplementation of it.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test"
import { EventEmitter } from "node:events"

import type { RequestContextSnapshot } from "~/lib/observability"

import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"
import { emergencyWrite } from "~/lib/tui/terminal-coordinator"

const NOW = 1_700_000_000_000

// eslint-disable-next-line unicorn/prefer-event-target -- Node stream API surface
class FakeStdin extends EventEmitter {
  setRawMode = mock((_: boolean) => this)
  resume = mock(() => this)
  pause = mock(() => this)
  removeListener = mock((event: string, fn: (...args: Array<unknown>) => void) => {
    EventEmitter.prototype.removeListener.call(this, event, fn)
    return this
  })

  asReadStream(): NodeJS.ReadStream {
    return this as unknown as NodeJS.ReadStream
  }
}

function makeStdout() {
  const chunks: Array<string> = []
  const stdout = { write: (s: string) => (chunks.push(s), true), isTTY: true } as unknown as NodeJS.WritableStream
  return { stdout, chunks, text: () => chunks.join("") }
}

function makeCtx(id: string, model: string, startOffsetMs: number): RequestContextSnapshot {
  return {
    id,
    endpoint: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    resolvedModel: model,
    clientModel: model,
    state: "streaming",
    startTime: NOW - startOffsetMs,
    queueWaitMs: 0,
  } satisfies RequestContextSnapshot
}

beforeEach(() => setSystemTime(new Date(NOW)))
afterEach(() => setSystemTime())

describe("TerminalUi ↔ terminal-coordinator registration (P2.2)", () => {
  test("interactive + panel established → emergencyWrite clears the panel, writes the line, redraws the panel — one atomic write", () => {
    const bus = createBus()
    const { stdout, chunks } = makeStdout()
    const stdin = new FakeStdin()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 10,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })

    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "gpt-5", 1000) })
    stdin.emit("data", Buffer.from(" ")) // space → panel → Region.render establishes DECSTBM

    const mark = chunks.length
    emergencyWrite("EMERGENCY LINE")
    const out = chunks.slice(mark).join("")

    // One atomic emergencyWrite call → exactly one chunk written to stdout.
    expect(chunks.length - mark).toBe(1)
    expect(out).toContain("EMERGENCY LINE")
    // Re-establishes/redraws the panel content (the active request row) after
    // the emergency line — same content a normal re-render would show.
    expect(out).toContain("aaaaaaaa")

    ui.destroy()
  })

  test("detail alt-screen active → emergencyWrite is a write-through (no clear/redraw escape noise)", () => {
    const bus = createBus()
    const { stdout, chunks } = makeStdout()
    const stdin = new FakeStdin()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 10,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })

    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "gpt-5", 1000) })
    stdin.emit("data", Buffer.from(" ")) // panel
    stdin.emit("data", Buffer.from("\r")) // enter → detail (alt screen)

    const mark = chunks.length
    emergencyWrite("EMERGENCY LINE")
    const out = chunks.slice(mark).join("")

    expect(out).toBe("EMERGENCY LINE\n") // write-through, no clear/redraw escape sequences

    ui.destroy()
  })

  test("non-interactive with footer visible → emergencyWrite clears + writes + redraws the P0 inline footer", () => {
    const bus = createBus()
    const { stdout, chunks } = makeStdout()
    const ui = new TerminalUi(bus, { stdout, isTTY: true, columns: 80 }) // non-interactive (no stdin)

    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "gpt-5", 1000) })
    // Trigger a footer render synchronously (avoids the 100ms timer).
    bus.scope("system").publish({ kind: "system.log", logType: "info", message: "tick", time: Date.now() })
    expect(chunks.join("")).toContain("[<-->]") // footer is now visible

    const mark = chunks.length
    emergencyWrite("EMERGENCY LINE")
    const out = chunks.slice(mark).join("")

    expect(chunks.length - mark).toBe(1) // one atomic write
    expect(out).toContain("\x1b[2K\r") // CLEAR_LINE before the emergency line
    expect(out).toContain("EMERGENCY LINE")
    expect(out).toContain("[<-->]") // footer redrawn after

    ui.destroy()
  })

  test("interactive but idle/collapsed (no established region) → emergencyWrite is a write-through", () => {
    const bus = createBus()
    const { stdout, chunks } = makeStdout()
    const stdin = new FakeStdin()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 10,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    // No active requests, no keypress: collapsed view is empty → Region never
    // establishes (renderRegion's `lines.length === 0` → `region.clear()` branch).

    const mark = chunks.length
    emergencyWrite("EMERGENCY LINE")
    const out = chunks.slice(mark).join("")

    expect(out).toBe("EMERGENCY LINE\n") // no panel to clear/redraw

    ui.destroy()
  })

  test("reentrant emergencyWrite during a render is NOT swallowed by the `rendering` guard (spec I4)", () => {
    const bus = createBus()
    const { stdout, chunks } = makeStdout()
    const stdin = new FakeStdin()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 10,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })

    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "gpt-5", 1000) })
    stdin.emit("data", Buffer.from(" ")) // panel established

    // Simulate a reentrant call arriving WHILE a render is in flight: a
    // system.log subscriber that calls emergencyWrite synchronously during the
    // bus fan-out that also drives this instance's own printLog→renderRegion.
    const unsub = bus.subscribe((e) => {
      if (e.kind === "system.log") emergencyWrite("REENTRANT EMERGENCY")
    })

    const mark = chunks.length
    bus.scope("system").publish({ kind: "system.log", logType: "info", message: "trigger", time: Date.now() })
    const out = chunks.slice(mark).join("")

    // The reentrant emergency line must actually reach stdout — not be dropped
    // by TerminalUi's `rendering` reentrancy guard (that guard exists to stop a
    // render recursing into itself, not to gate emergency writes).
    expect(out).toContain("REENTRANT EMERGENCY")

    unsub()
    ui.destroy()
  })

  test("destroy() unregisters — a subsequent emergencyWrite falls back to stderr, not this instance", () => {
    const bus = createBus()
    const { stdout, chunks } = makeStdout()
    const stdin = new FakeStdin()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 10,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "gpt-5", 1000) })
    stdin.emit("data", Buffer.from(" "))
    ui.destroy()

    const stderrWrite = mock((_s: string | Uint8Array) => true)
    const original = process.stderr.write
    process.stderr.write = stderrWrite as unknown as typeof process.stderr.write
    const mark = chunks.length
    try {
      emergencyWrite("AFTER DESTROY")
    } finally {
      process.stderr.write = original
    }

    expect(chunks.length).toBe(mark) // this instance's stdout never saw it
    expect(stderrWrite).toHaveBeenCalledTimes(1)
    expect(stderrWrite.mock.calls[0][0]).toBe("AFTER DESTROY\n")
  })

  test("silent instance never registers — emergencyWrite falls straight through to stderr", () => {
    const bus = createBus()
    const { stdout } = makeStdout()
    const ui = new TerminalUi(bus, { stdout, isTTY: true, columns: 80, silent: true })

    const stderrWrite = mock((_s: string | Uint8Array) => true)
    const original = process.stderr.write
    process.stderr.write = stderrWrite as unknown as typeof process.stderr.write
    try {
      emergencyWrite("SILENT INSTANCE")
    } finally {
      process.stderr.write = original
    }

    expect(stderrWrite).toHaveBeenCalledTimes(1)
    expect(stderrWrite.mock.calls[0][0]).toBe("SILENT INSTANCE\n")

    ui.destroy()
  })
})
