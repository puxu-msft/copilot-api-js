/**
 * P1 terminal-restore robustness oracle — the crash / exit / shutdown paths that
 * must all funnel through the single idempotent `restoreTerminal`.
 *
 * Task 5 wired raw-mode input; Task 6 hardens the *restore* side across the
 * four exit paths (exit-hook, destroy, shutdown-drain, throw→exit-hook). These
 * pins drive the real `bus → TerminalUi` path with an injected fake stdin and a
 * capturing stdout, asserting:
 *
 *   - **exit-hook**: the registered hook fn → `restoreTerminal` (raw mode off +
 *     region reset `\x1b[r`), even though `destroy()` was never called;
 *   - **shutdown scheme A** (RFC §7): `system.shutdown_phase_changed{draining}`
 *     → `restoreTerminal` + the region stops rendering (a later redraw trigger
 *     emits no new DECSTBM — the drain period is a plain log stream);
 *   - **idempotency**: exit-hook then `destroy()` restores exactly once
 *     (`setRawMode(false)` / `removeListener` fire a single time);
 *   - **non-interactive gate**: no stdin injected → the shutdown-drain event and
 *     any restore are inert (no raw mode, `process.stdin` untouched).
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

const NOW = 1_700_000_000_000

// DECSTBM set-scroll-region sequence `\x1b[1;<N>r` — the Region's tell that it
// established a sticky bottom panel.
// eslint-disable-next-line no-control-regex -- intentional ESC control char
const DECSTBM_SET = /\x1b\[1;\d+r/
// DECSTBM reset — the scroll region is torn back down to the full screen.
const SCROLL_RESET = "\x1b[r"
// Alternate-screen leave sequence — the terminal must drop back to the
// primary screen before any cooked-mode teardown runs (C2).
const ALT_SCREEN_LEAVE = "\x1b[?1049l"
// Cursor-show sequence written by `Region.clear()` at the tail of restore.
const SHOW_CURSOR = "\x1b[?25h"

/**
 * Fake raw-mode stdin: an EventEmitter with the ReadStream methods spied
 * (mirrors the Task 5 interactive harness).
 */
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

/** A minimal streaming request context for the panel view. */
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

/** Build an interactive TerminalUi with injected stdin + exit-hook capture. */
function makeInteractiveUi() {
  const bus = createBus()
  const { stdout, chunks } = makeStdout()
  const stdin = new FakeStdin()
  const onShutdownSignal = mock((_: string) => {})
  let exitHook: (() => void) | undefined
  const registerExitHook = mock((fn: () => void) => {
    exitHook = fn
  })
  const ui = new TerminalUi(bus, {
    stdout,
    isTTY: true,
    columns: 80,
    rows: 10,
    stdin: stdin.asReadStream(),
    onShutdownSignal,
    registerExitHook,
  })
  return { bus, ui, stdin, chunks, sliceFrom: (m: number) => chunks.slice(m).join(""), exitHook: () => exitHook }
}

beforeEach(() => setSystemTime(new Date(NOW)))
afterEach(() => setSystemTime())

describe("TerminalUi — terminal restore robustness (Task 6)", () => {
  test("exit-hook fn → restoreTerminal (raw mode off + region reset), no destroy()", () => {
    const { bus, stdin, chunks, sliceFrom, exitHook } = makeInteractiveUi()

    // Open a panel so the Region is established (a reset is observable on restore).
    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "gpt-5", 1000) })
    stdin.emit("data", Buffer.from(" ")) // space → panel → Region.render establishes DECSTBM

    const hook = exitHook()
    expect(hook).toBeDefined()

    const mark = chunks.length
    hook?.() // simulate process "exit" — destroy() was never called
    const out = sliceFrom(mark)

    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false)
    expect(stdin.removeListener).toHaveBeenCalledWith("data", expect.any(Function))
    expect(stdin.pause).toHaveBeenCalled()
    expect(out).toContain(SCROLL_RESET) // region torn down (DECSTBM reset)
  })

  test("shutdown scheme A: draining → restoreTerminal + region stops rendering", () => {
    const { bus, stdin, chunks, sliceFrom } = makeInteractiveUi()
    const req = bus.scope("request")

    req.publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "gpt-5", 1000) })
    stdin.emit("data", Buffer.from(" ")) // panel established

    // Draining transition restores the terminal (scheme A) and resets the region.
    let mark = chunks.length
    bus.scope("system").publish({ kind: "system.shutdown_phase_changed", phase: "draining", previousPhase: null, needsFlush: false })
    const drainOut = sliceFrom(mark)
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false) // left raw mode
    expect(drainOut).toContain(SCROLL_RESET) // region torn down

    // The drain period is now a plain log stream: further redraw triggers emit
    // no new DECSTBM (renderRegion no-ops once shuttingDown).
    mark = chunks.length
    req.publish({ kind: "request.created", ctx: makeCtx("bbbbbbbb", "gpt-5", 500) })
    req.publish({ kind: "request.state_changed", ctx: makeCtx("bbbbbbbb", "gpt-5", 500), previousState: "streaming" } as never)
    stdin.emit("data", Buffer.from(" ")) // input after drain — must not re-establish a region
    const afterDrain = sliceFrom(mark)
    expect(afterDrain).not.toMatch(DECSTBM_SET) // no new sticky panel — pure log stream
  })

  test("idempotent: exit-hook then destroy() restores exactly once", () => {
    const { ui, stdin, exitHook } = makeInteractiveUi()

    const hook = exitHook()
    hook?.() // first restore
    const rawModeCallsAfterFirst = stdin.setRawMode.mock.calls.length
    const removeCallsAfterFirst = stdin.removeListener.mock.calls.length

    ui.destroy() // second restore attempt — latched, must be a no-op
    expect(stdin.setRawMode.mock.calls.length).toBe(rawModeCallsAfterFirst)
    expect(stdin.removeListener.mock.calls.length).toBe(removeCallsAfterFirst)
  })

  test("idempotent: draining phase twice restores exactly once", () => {
    const { bus, stdin } = makeInteractiveUi()
    const sys = bus.scope("system")

    sys.publish({ kind: "system.shutdown_phase_changed", phase: "draining", previousPhase: null, needsFlush: false })
    const rawModeCalls = stdin.setRawMode.mock.calls.length
    // A second draining (or later phase) must not re-run restore.
    sys.publish({ kind: "system.shutdown_phase_changed", phase: "draining", previousPhase: "draining", needsFlush: false })
    sys.publish({ kind: "system.shutdown_phase_changed", phase: "aborting", previousPhase: "draining", needsFlush: false })
    expect(stdin.setRawMode.mock.calls.length).toBe(rawModeCalls)
  })

  test("restore while in detail leaves the alt screen first (C2)", () => {
    const { bus, stdin, chunks, sliceFrom, exitHook } = makeInteractiveUi()

    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "gpt-5", 1000) })
    stdin.emit("data", Buffer.from(" ")) // space → panel
    stdin.emit("data", Buffer.from("\r")) // enter → detail (alt screen entered)

    const hook = exitHook()
    expect(hook).toBeDefined()

    const mark = chunks.length
    hook?.() // simulate a crash/exit path — restoreTerminal fires while still in detail
    const out = sliceFrom(mark)

    const altScreenLeaveAt = out.indexOf(ALT_SCREEN_LEAVE)
    expect(altScreenLeaveAt).toBeGreaterThanOrEqual(0) // leaves the alt screen first
    expect(altScreenLeaveAt).toBeLessThan(out.indexOf(SHOW_CURSOR)) // …before cursor/scroll-region teardown
  })

  test("shutdown-drain while detail is open leaves the alt screen before restoring (P1.5 regression)", () => {
    const { bus, stdin, chunks, sliceFrom } = makeInteractiveUi()

    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "gpt-5", 1000) })
    stdin.emit("data", Buffer.from(" ")) // space → panel
    stdin.emit("data", Buffer.from("\r")) // enter → detail (alt screen entered)

    const mark = chunks.length
    // Drain arrives via the real event path (not a simulated exit hook) while
    // detail is still on the alternate screen.
    bus.scope("system").publish({ kind: "system.shutdown_phase_changed", phase: "draining", previousPhase: null, needsFlush: false })
    const out = sliceFrom(mark)

    const altScreenLeaveAt = out.indexOf(ALT_SCREEN_LEAVE)
    expect(altScreenLeaveAt).toBeGreaterThanOrEqual(0) // must drop back to the primary screen
    expect(altScreenLeaveAt).toBeLessThan(out.indexOf(SHOW_CURSOR)) // …before the region's cursor/scroll teardown
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false) // raw mode also left

    // No stale detail repaint is attempted afterward: a further redraw trigger
    // (e.g. an inert key) must not re-enter the alt screen or re-render detail.
    const afterMark = chunks.length
    stdin.emit("data", Buffer.from([0x1b, 0x5b, 0x41])) // \x1b[A — inert, but exercises render() post-drain
    const afterOut = sliceFrom(afterMark)
    expect(afterOut).not.toContain("\x1b[?1049h") // never re-enters the alt screen
  })

  test("non-interactive (no stdin) → shutdown-drain + restore are inert, no exit hook", () => {
    const bus = createBus()
    const { stdout, text } = makeStdout()
    const registerExitHook = mock((_fn: () => void) => {})

    const ui = new TerminalUi(bus, { stdout, isTTY: true, columns: 80, rows: 10, registerExitHook })
    expect(registerExitHook).not.toHaveBeenCalled() // no exit hook on the P0 path

    // The shutdown-drain event must be a no-op (no raw mode, no DECSTBM, no throw).
    expect(() =>
      bus.scope("system").publish({ kind: "system.shutdown_phase_changed", phase: "draining", previousPhase: null, needsFlush: false }),
    ).not.toThrow()

    ui.destroy()
    expect(text()).not.toMatch(DECSTBM_SET) // never established a Region
  })
})
