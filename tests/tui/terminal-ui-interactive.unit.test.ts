/**
 * P1 interactive integration oracle — raw-mode input + unified Region rendering.
 *
 * Drives the real `bus → TerminalUi` path with an injected fake stdin
 * (`EventEmitter` subclass with `setRawMode`/`resume`/`pause`/`removeListener`
 * spies), a capturing fake stdout, and injected `rows`/`onShutdownSignal`/
 * `registerExitHook`. Asserts the wired behaviour the four leaves (keys /
 * region / panel / controller) compose into:
 *
 *   - construct (interactive) → `setRawMode(true)` + `resume()` + exit-hook
 *     registered;
 *   - `space` (with active requests) → panel via `Region.render` (DECSTBM
 *     `\x1b[1;<N>r`, per-row content);
 *   - `down` → selection moves (reverse-video on the next row);
 *   - `enter` → detail (`req_id:` block);
 *   - `escape ×2` → back to collapsed; collapsed default is N=1 (user
 *     2026-07-11), so the panel→collapsed shrink DOES re-emit the DECSTBM
 *     reset `\x1b[r` (geometry changes). The grow direction never eats a log
 *     line via Region scroll-before-grow (pty+pyte oracle `pty_grid_test.py`).
 *   - `ctrl-c` (0x03) → injected `onShutdownSignal("SIGINT")`;
 *   - `destroy()` → `setRawMode(false)` + `removeListener("data")` + `pause()`
 *     + region reset;
 *   - **no stdin injected** (mirrors golden / attach-order tests) → the gate
 *     stays non-interactive: `process.stdin` is never touched, no raw mode, no
 *     exit hook, P0 footer path (no DECSTBM).
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

import { createDiagnosticEvent } from "~/lib/diagnostics"
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

const NOW = 1_700_000_000_000

function diagnostic(message: string) {
  return {
    kind: "system.diagnostic" as const,
    diagnostic: createDiagnosticEvent({ level: "info", event: "test.interactive", message, timeUnixMs: NOW, origin: "native" }),
  }
}

// DECSTBM set-scroll-region sequence `\x1b[1;<N>r` — the Region's tell that it
// established a sticky bottom panel (absent on the P0 footer path).
// eslint-disable-next-line no-control-regex -- intentional ESC control char
const DECSTBM_SET = /\x1b\[1;\d+r/
// Reverse-video (SGR 7) prefixing a short request id — the selection cursor.
// Built dynamically so no-control-regex has no static literal to flag.
const reverseRow = (id: string): RegExp => new RegExp(`\\x1b\\[7m${id}`)
// DECSTBM reset — the scroll region is torn back down to the full screen.
// Only expected on an actual geometry change (resize / first establish /
// teardown); a collapsed↔panel view switch is now constant-height (spec
// INV-2) and must NOT emit this.
const SCROLL_RESET = "\x1b[r"

/**
 * Fake raw-mode stdin: an EventEmitter with the ReadStream methods spied. Must
 * mirror a Node stream — TerminalUi calls `.on("data")` / `.removeListener`,
 * which are EventEmitter APIs (not EventTarget's add/removeEventListener).
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

/** A minimal streaming request context for the panel/detail views. */
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

describe("TerminalUi — P1 interactive integration", () => {
  test("raw-mode lifecycle + collapsed↔panel↔detail navigation via injected stdin", () => {
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

    // ① construct (interactive) sets up raw mode + exit hook.
    expect(stdin.setRawMode).toHaveBeenCalledWith(true)
    expect(stdin.resume).toHaveBeenCalled()
    expect(registerExitHook).toHaveBeenCalledTimes(1)
    expect(exitHook).toBeDefined()

    // Three active requests so selection movement + scrolling are observable.
    const req = bus.scope("request")
    req.publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 3000) })
    req.publish({ kind: "request.created", ctx: makeCtx("bbbbbbbb", "gpt-5", 2000) })
    req.publish({ kind: "request.created", ctx: makeCtx("cccccccc", "gpt-5", 1000) })

    const since = (): number => chunks.length
    const sliceFrom = (mark: number): string => chunks.slice(mark).join("")

    // ② space → panel via Region.render (DECSTBM set + row content).
    let mark = since()
    stdin.emit("data", Buffer.from(" "))
    const panelOut = sliceFrom(mark)
    expect(panelOut).toMatch(DECSTBM_SET) // DECSTBM scroll region established
    expect(panelOut).toContain("aaaaaaaa") // first request row rendered
    expect(panelOut).toMatch(reverseRow("aaaaaaaa")) // selectedIndex 0 reverse-video

    // ③ down → selection moves to the second row.
    mark = since()
    stdin.emit("data", Buffer.from([0x1b, 0x5b, 0x42])) // \x1b[B
    const downOut = sliceFrom(mark)
    expect(downOut).toMatch(reverseRow("bbbbbbbb")) // second row now reverse-video

    // ④ enter → detail view of the selected (second) request.
    mark = since()
    stdin.emit("data", Buffer.from("\r"))
    const detailOut = sliceFrom(mark)
    expect(detailOut).toContain("req_id: bbbbbbbb")

    // ⑤ escape ×2 → detail → panel → collapsed. Default collapsed = N=1
    //    (user 2026-07-11): the panel→collapsed shrink DOES change geometry, so
    //    the region re-anchors (DECSTBM reset re-issued). Blank gaps on shrink
    //    are tolerated; the grow direction is what must never eat a log line
    //    (Region scroll-before-grow — see the dedicated tests below + the
    //    pty+pyte oracle `exp/tui-rawmode/pty_grid_test.py`).
    stdin.emit("data", Buffer.from("\x1bx")) // escape → panel; x is an inert trailing char
    mark = since()
    stdin.emit("data", Buffer.from("\x1bx")) // escape → collapsed (3→1 shrink, re-anchors)
    const collapseOut = sliceFrom(mark)
    expect(collapseOut).toContain(SCROLL_RESET) // DECSTBM reset re-issued — geometry shrank

    // ⑥ ctrl-c → injected shutdown signal.
    stdin.emit("data", Buffer.from([0x03]))
    expect(onShutdownSignal).toHaveBeenCalledWith("SIGINT")
    stdin.emit("data", Buffer.from("q"))
    stdin.emit("data", Buffer.from([0x04]))
    expect(onShutdownSignal).toHaveBeenCalledTimes(3)

    // ⑦ destroy → restore terminal: raw mode off, listener detached, paused.
    ui.destroy()
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false)
    expect(stdin.removeListener).toHaveBeenCalledWith("data", expect.any(Function))
    expect(stdin.pause).toHaveBeenCalled()
    // After destroy the data listener is gone — further input is inert.
    const afterDestroy = since()
    stdin.emit("data", Buffer.from(" "))
    expect(chunks.length).toBe(afterDestroy)
  })

  test("no stdin injected → gate stays non-interactive (P0 path, process.stdin untouched)", () => {
    const bus = createBus()
    const { stdout, text } = makeStdout()
    const registerExitHook = mock((_fn: () => void) => {})

    // isTTY:true but NO stdin option → interactive gate is false; the sink must
    // never touch process.stdin nor register an exit hook.
    const ui = new TerminalUi(bus, { stdout, isTTY: true, columns: 80, rows: 10, registerExitHook })
    expect(registerExitHook).not.toHaveBeenCalled()

    const req = bus.scope("request")
    req.publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 1000) })
    req.publish({
      kind: "request.completed",
      ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 1000),
      entry: { id: "aaaaaaaa", endpoint: "anthropic-messages", state: "completed" },
    } as never)
    ui.destroy()

    const out = text()
    expect(out).not.toMatch(DECSTBM_SET) // no DECSTBM — P0 footer path, not Region
    expect(out).toContain("[ OK ]") // P0 log line still rendered
  })

  test("TERM=dumb forces the plain non-interactive renderer", () => {
    const previous = process.env.TERM
    process.env.TERM = "dumb"
    try {
      const stdin = new FakeStdin()
      const { stdout, chunks } = makeStdout()
      const bus = createBus()
      const ui = new TerminalUi(bus, { stdout, isTTY: true, stdin: stdin.asReadStream(), registerExitHook: () => {} })
      bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("plain", "model", 1000) })
      expect(stdin.setRawMode).not.toHaveBeenCalled()
      expect(chunks.join("")).not.toContain("\x1b[1;")
      ui.destroy()
    } finally {
      if (previous === undefined) delete process.env.TERM
      else process.env.TERM = previous
    }
  })

  test("selected last request settling before enter reconciles to a surviving row instead of a blank pseudo-detail", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const ui = new TerminalUi(bus, { stdout, isTTY: true, columns: 80, rows: 24, stdin: stdin.asReadStream(), registerExitHook: () => {} })
    const req = bus.scope("request")
    req.publish({ kind: "request.created", ctx: makeCtx("r1", "m1", 3000) })
    req.publish({ kind: "request.created", ctx: makeCtx("r2", "m2", 2000) })
    req.publish({ kind: "request.created", ctx: makeCtx("r3", "m3", 1000) })
    stdin.emit("data", Buffer.from(" "))
    stdin.emit("data", Buffer.from("\x1b[B\x1b[B"))
    req.publish({
      kind: "request.completed",
      ctx: { ...makeCtx("r3", "m3", 1000), state: "completed" },
      entry: { id: "r3", endpoint: "anthropic-messages", state: "completed" },
    } as never)
    chunks.length = 0
    stdin.emit("data", Buffer.from("\r"))
    const out = chunks.join("")
    expect(out).toContain("\x1b[?1049h")
    expect(out).toContain("req_id: r2")
    ui.destroy()
  })

  test("collapsed default is a single row (N=1), not padded to the panel height", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 24,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("r1", "claude-opus-4-8", 1000) })
    chunks.length = 0
    bus.scope("system").publish(diagnostic("x"))
    // Collapsed with a single in-flight request: the DECSTBM region reserves
    // exactly ONE bottom row (rows-1 = 23) — user 2026-07-11 wants the default
    // view to occupy one row, not the padded MAX_PANEL_ROWS.
    const bottoms = new Set(
      // eslint-disable-next-line no-control-regex -- intentional ESC control char
      [...chunks.join("").matchAll(/\x1b\[1;(\d+)r/g)].map((m) => m[1]),
    )
    expect(bottoms).toEqual(new Set(["23"])) // 24 rows, panelHeight 1 → scroll region 1..23
    ui.destroy()
  })

  test("scroll-before-grow: collapsed→panel (region grows) pushes bottom logs into scrollback, never eats them", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 24,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("r1", "claude-opus-4-8", 1000) })
    bus.scope("system").publish(diagnostic("x"))
    chunks.length = 0
    stdin.emit("data", Buffer.from(" ")) // collapsed (N=1) → panel (N=3): region grows by 2
    const out = chunks.join("")
    // Before the taller region is (re)established, the old scroll region's
    // bottom is scrolled up by delta=2 (two newlines parked at the old bottom
    // row 23) so the 2 log rows the taller panel is about to claim are pushed
    // into scrollback instead of overwritten. Positive control: without this,
    // the pty+pyte oracle reports eaten lines (see the experiment log).
    const iScroll = out.indexOf("\x1b[23;1H\n\n")
    const iReset = out.indexOf(SCROLL_RESET)
    expect(iScroll).toBeGreaterThanOrEqual(0) // scroll-before-grow emitted
    expect(iReset).toBeGreaterThan(iScroll) // ...before the region tear-down/re-anchor
    ui.destroy()
  })

  test("detail enters the alternate screen and resets scroll margins (C1)", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 24,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 1000) })

    stdin.emit("data", Buffer.from(" ")) // collapsed → panel
    stdin.emit("data", Buffer.from("\r")) // panel → detail (enter)
    const out = chunks.join("")
    const iAlt = out.indexOf("\x1b[?1049h")
    const iReset = out.indexOf("\x1b[r", iAlt)
    expect(iAlt).toBeGreaterThanOrEqual(0) // entered the alternate screen
    expect(iReset).toBeGreaterThan(iAlt) // C1: reset scroll margins AFTER entering (order matters)
    ui.destroy()
  })

  test("printLog guards the detail alt-screen: concurrent log lines while detail is open don't corrupt it", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 24,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    const req = bus.scope("request")
    req.publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 1000) })

    stdin.emit("data", Buffer.from(" ")) // collapsed → panel
    stdin.emit("data", Buffer.from("\r")) // panel → detail (enter)
    chunks.length = 0 // only inspect output produced while detail is open

    // Concurrent request lifecycle events — each would normally reach
    // `printLog` (via `onCreated`/`onTerminal`/`onSystemLog`) and, absent the
    // `detailActive` guard, call `renderRegion` → `region.clear()`, which
    // writes `RESET_SCROLL_REGION` + `ERASE_TO_END` + `SHOW_CURSOR` straight
    // into the alt screen and wipes the detail paint.
    bus.scope("system").publish(diagnostic("concurrent"))
    req.publish({ kind: "request.created", ctx: makeCtx("bbbbbbbb", "gpt-5", 500) })
    req.publish({
      kind: "request.completed",
      ctx: makeCtx("bbbbbbbb", "gpt-5", 500),
      entry: { id: "bbbbbbbb", endpoint: "anthropic-messages", state: "completed" },
    } as never)

    const out = chunks.join("")
    // `region.clear()`'s signature bytes must not have leaked into the alt
    // screen — that would mean the guard is missing (or bypassed) and the
    // detail paint got corrupted.
    // eslint-disable-next-line no-control-regex -- intentional ESC control chars under test
    expect(out).not.toMatch(/\x1b\[0J/) // ERASE_TO_END
    // eslint-disable-next-line no-control-regex -- intentional ESC control chars under test
    expect(out).not.toMatch(/\x1b\[\?25h/) // SHOW_CURSOR
    // The alt screen must still be open — no premature exit sequence either.
    // eslint-disable-next-line no-control-regex -- intentional ESC control chars under test
    expect(out).not.toMatch(/\x1b\[\?1049l/)
    ui.destroy()
  })

  test("esc from detail leaves the alt screen and re-establishes the region (P1.2)", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 24,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 1000) })

    stdin.emit("data", Buffer.from(" ")) // collapsed → panel
    stdin.emit("data", Buffer.from("\r")) // panel → detail (enter)
    chunks.length = 0
    stdin.emit("data", Buffer.from("\x1bx")) // detail → panel (esc)
    const out = chunks.join("")
    const iOff = out.indexOf("\x1b[?1049l")
    const iRegion = out.indexOf("\x1b[1;", iOff) // retreat off the alt screen, then rebuild DECSTBM
    expect(iOff).toBeGreaterThanOrEqual(0)
    expect(iRegion).toBeGreaterThan(iOff)
    // Discriminating assertion (the geometry hasn't changed — 24 rows, same
    // panel height — so `Region.render`'s "unchanged geometry" branch alone
    // would idempotently reassert DECSTBM without a real teardown/rebuild,
    // making the assertion above pass even with a no-op `exitDetail`).
    // `forceReestablish` must force `Region`'s "first establish" branch, whose
    // tell is `HIDE_CURSOR` (`\x1b[?25l`) — the idempotent-reassert branch
    // never emits it. Its presence after the alt-screen exit proves the
    // region was actually torn down and rebuilt from scratch, not merely
    // reasserted.
    const iHideCursor = out.indexOf("\x1b[?25l", iOff)
    expect(iHideCursor).toBeGreaterThan(iOff)
    ui.destroy()
  })

  test("logs during detail are queued (not written to alt screen) and replayed on exit", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 24,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 1000) })

    stdin.emit("data", Buffer.from(" ")) // collapsed → panel
    stdin.emit("data", Buffer.from("\r")) // panel → detail (enter)
    chunks.length = 0

    bus.scope("system").publish(diagnostic("DURING-DETAIL"))
    expect(chunks.join("")).not.toContain("DURING-DETAIL") // queued, not written to the alt screen

    stdin.emit("data", Buffer.from("\x1bx")) // esc → exit detail + replay
    expect(chunks.join("")).toContain("DURING-DETAIL") // replayed into the scrollback on exit
    ui.destroy()
  })

  test("replay queue is bounded at REPLAY_CAP — oldest entries drop, newest survive", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 24,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 1000) })

    stdin.emit("data", Buffer.from(" ")) // collapsed → panel
    stdin.emit("data", Buffer.from("\r")) // panel → detail (enter)
    chunks.length = 0

    const system = bus.scope("system")
    const REPLAY_CAP = 200
    const overflow = 10
    // Zero-padded so no message is a substring of another (e.g. "LOG-9" would
    // otherwise false-positive-match inside "LOG-90"/"LOG-99"/…).
    const label = (i: number) => `LOG-${String(i).padStart(4, "0")}`
    for (let i = 0; i < REPLAY_CAP + overflow; i++) {
      system.publish(diagnostic(label(i)))
    }

    stdin.emit("data", Buffer.from("\x1bx")) // esc → exit detail + replay
    const out = chunks.join("")
    // Oldest entries (dropped by the bound) must not survive the replay.
    expect(out).not.toContain(label(0))
    expect(out).not.toContain(label(overflow - 1))
    // The most recent REPLAY_CAP entries must survive, in order.
    expect(out).toContain(label(overflow))
    expect(out).toContain(label(REPLAY_CAP + overflow - 1))
    ui.destroy()
  })

  test("detail re-renders full-screen with reset margins on terminal resize (M7), never via the panel's Region/geometryChanged path", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const rowsRef = { rows: 24 }
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: () => rowsRef.rows,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 1000) })

    stdin.emit("data", Buffer.from(" ")) // collapsed → panel
    stdin.emit("data", Buffer.from("\r")) // panel → detail (enter)
    chunks.length = 0 // only inspect output produced after entering detail

    // Simulate a terminal resize while detail is open, then trigger a redraw
    // via an inert key (`up` is a no-op in detail per the reducer, but `onInput`
    // still calls `render()` afterward — the same path a footer-timer tick or a
    // bus-triggered repaint would take).
    rowsRef.rows = 40
    stdin.emit("data", Buffer.from([0x1b, 0x5b, 0x41])) // \x1b[A (up arrow)

    const out = chunks.join("")
    expect(out).toContain("\x1b[r") // margins reset defensively on resize (M7)
    expect(out).toContain("\x1b[H\x1b[2J") // full-screen repaint
    expect(out).not.toMatch(DECSTBM_SET) // must NOT re-anchor via the panel's Region/geometryChanged path
    ui.destroy()
  })

  test("detail re-render WITHOUT a resize does not reset margins again", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const rowsRef = { rows: 24 }
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: () => rowsRef.rows,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 1000) })

    stdin.emit("data", Buffer.from(" ")) // collapsed → panel
    stdin.emit("data", Buffer.from("\r")) // panel → detail (enter)
    chunks.length = 0

    // No resize — geometry unchanged. An inert key still triggers a repaint
    // (content refresh), but must NOT re-emit the margin reset.
    stdin.emit("data", Buffer.from([0x1b, 0x5b, 0x41])) // \x1b[A (up arrow), no-op in detail

    const out = chunks.join("")
    expect(out).toContain("\x1b[H\x1b[2J") // still repaints content
    expect(out).not.toContain("\x1b[r") // no margin reset — geometry unchanged
    ui.destroy()
  })

  test("INV-1: collapsed→panel→collapsed round-trip — grow leg scroll-before-grows (no eat), shrink leg re-anchors", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 24,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    bus.scope("request").publish({ kind: "request.created", ctx: makeCtx("r1", "claude-opus-4-8", 1000) })
    bus.scope("system").publish(diagnostic("SENTINEL"))
    chunks.length = 0
    stdin.emit("data", Buffer.from(" ")) // collapsed (N=1) → panel (N=3): GROW
    const growOut = chunks.join("")
    chunks.length = 0
    stdin.emit("data", Buffer.from(" ")) // panel (N=3) → collapsed (N=1): SHRINK
    const shrinkOut = chunks.join("")
    // Grow leg: scroll-before-grow (park at old bottom row 23, emit delta=2
    // newlines) pushes the 2 log rows the taller panel will claim into
    // scrollback BEFORE the region tear-down — so no log line is overwritten.
    // (End-to-end no-eat across many toggles is proven by the pty+pyte oracle
    // `exp/tui-rawmode/pty_grid_test.py`; this pins the load-bearing byte.)
    expect(growOut).toContain("\x1b[23;1H\n\n")
    // Shrink leg: freed rows just become blank gaps (tolerated, user 2026-07-11);
    // the region re-anchors (DECSTBM reset). No scroll-before-grow needed.
    expect(shrinkOut).toContain(SCROLL_RESET)
    expect(shrinkOut).not.toContain("\x1b[23;1H\n\n") // shrink does NOT scroll-before-grow
    ui.destroy()
  })

  test("I1: viewing the ONLY active request's detail — it completes → detail degrades instead of freezing", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 24,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    const req = bus.scope("request")
    req.publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 1000) })

    stdin.emit("data", Buffer.from(" ")) // collapsed → panel
    stdin.emit("data", Buffer.from("\r")) // panel → detail (enter), viewing aaaaaaaa
    chunks.length = 0

    // The viewed request completes WITHOUT any further user input — no esc, no
    // keypress. Before the I1 fix this only queued the log line into
    // replayQueue and never re-rendered: the alt screen stayed frozen on stale
    // content until the user manually pressed esc.
    req.publish({
      kind: "request.completed",
      ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 1000),
      entry: { id: "aaaaaaaa", endpoint: "anthropic-messages", state: "completed" },
    } as never)

    const out = chunks.join("")
    expect(out).toContain("\x1b[?1049l") // alt screen exited — degrade, not frozen
    ui.destroy()
  })

  test("I1: viewing a non-last active request's detail — it completes → degrades (never silently shows a different entry)", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 24,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    const req = bus.scope("request")
    req.publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 3000) })
    req.publish({ kind: "request.created", ctx: makeCtx("bbbbbbbb", "gpt-5", 2000) })
    req.publish({ kind: "request.created", ctx: makeCtx("cccccccc", "gpt-5", 1000) })

    stdin.emit("data", Buffer.from(" ")) // collapsed → panel, selectedIndex 0 (aaaaaaaa)
    stdin.emit("data", Buffer.from("\r")) // panel → detail, viewing aaaaaaaa (index 0, NOT last)
    chunks.length = 0

    // The VIEWED request (aaaaaaaa, at index 0 — not the last) completes.
    // Removing it left-shifts the array so index 0 now holds bbbbbbbb — the
    // pre-fix bug rendered bbbbbbbb's detail INTO the still-open alt screen via
    // the next footer-timer tick's index-based lookup, silently switching the
    // view without any user action. The fix tracks the viewed identity, so it
    // must degrade instead of ever painting a different request.
    req.publish({
      kind: "request.completed",
      ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 3000),
      entry: { id: "aaaaaaaa", endpoint: "anthropic-messages", state: "completed" },
    } as never)

    const out = chunks.join("")
    expect(out).not.toContain("req_id: bbbbbbbb") // never silently switched to a different entry
    expect(out).toContain("\x1b[?1049l") // degrades (exits alt screen) instead
    ui.destroy()
  })

  // Root-cause re-fix (whole-branch review I1 re-review): the prior fix's
  // `onTerminal`-only `exitDetail()` call was a symptom patch that introduced
  // a regression (residual A) and left a sibling-shaped variant uncovered
  // (residual B). Both are exercised below by driving a SECOND render after
  // the terminal event — via an inert-in-detail keypress, which mirrors
  // exactly what the next 100ms footer-timer tick would do (both re-dispatch
  // through the same `render()` method) without depending on real timers.

  test("I1 residual A: onTerminal's direct exitDetail() resets uiState.view — a later render never bounces back into the alt screen", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 24,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    const req = bus.scope("request")
    req.publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 2000) })
    req.publish({ kind: "request.created", ctx: makeCtx("bbbbbbbb", "gpt-5", 1000) })

    stdin.emit("data", Buffer.from(" ")) // collapsed → panel, selectedIndex 0 (aaaaaaaa)
    stdin.emit("data", Buffer.from("\r")) // panel → detail, viewing aaaaaaaa

    // The VIEWED request completes — `onTerminal`'s direct `exitDetail()`
    // degrade fires (already covered by the "ONLY active request" test above:
    // this same publish emits `\x1b[?1049l` immediately). What that test does
    // NOT exercise is what happens on the NEXT render.
    req.publish({
      kind: "request.completed",
      ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 2000),
      entry: { id: "aaaaaaaa", endpoint: "anthropic-messages", state: "completed" },
    } as never)
    chunks.length = 0 // only inspect output from the render simulating the next footer-timer tick

    // Before the root-cause fix, `exitDetail()` cleared `detailActive` but left
    // `uiState.view === "detail"` (only the reducer's `escape` transition set
    // it to `"panel"`, and this direct call bypasses the reducer entirely). So
    // the very next `render()` dispatch (footer timer / any further input)
    // still routed to `renderDetail()`, which unconditionally re-wrote
    // `\x1b[?1049h` and repainted — bouncing back into the alt screen on
    // stale/shifted content instead of staying on the panel it just degraded
    // to. `up` is inert in the reducer's `detail` case (a no-op transition),
    // isolating this assertion to "did the NEXT render dispatch correctly" —
    // not "did this keypress do anything else".
    stdin.emit("data", Buffer.from([0x1b, 0x5b, 0x41])) // \x1b[A (up arrow)
    const out = chunks.join("")
    expect(out).not.toContain("\x1b[?1049h") // must not bounce back into the alt screen
    ui.destroy()
  })

  test("I1 residual B: viewing B while an earlier sibling (A) terminates — a later render still shows B, never the entry that shifted into its old index", () => {
    const stdin = new FakeStdin()
    const { stdout, chunks } = makeStdout()
    const bus = createBus()
    const ui = new TerminalUi(bus, {
      stdout,
      isTTY: true,
      columns: 80,
      rows: 24,
      stdin: stdin.asReadStream(),
      registerExitHook: () => {},
    })
    const req = bus.scope("request")
    req.publish({ kind: "request.created", ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 3000) })
    req.publish({ kind: "request.created", ctx: makeCtx("bbbbbbbb", "gpt-5", 2000) })
    req.publish({ kind: "request.created", ctx: makeCtx("cccccccc", "gpt-5", 1000) })

    stdin.emit("data", Buffer.from(" ")) // collapsed → panel, selectedIndex 0 (aaaaaaaa)
    stdin.emit("data", Buffer.from([0x1b, 0x5b, 0x42])) // down → selectedIndex 1 (bbbbbbbb)
    stdin.emit("data", Buffer.from("\r")) // panel → detail, viewing bbbbbbbb (index 1)

    // A sibling (aaaaaaaa, index 0 — NOT the viewed request) terminates.
    // Removing it left-shifts `active`'s iteration order: bbbbbbbb moves from
    // index 1 to index 0, cccccccc from index 2 to index 1 — so a naive
    // re-lookup by the STILL-1 `selectedIndex` would now resolve to
    // cccccccc, not bbbbbbbb.
    req.publish({
      kind: "request.completed",
      ctx: makeCtx("aaaaaaaa", "claude-opus-4-8", 3000),
      entry: { id: "aaaaaaaa", endpoint: "anthropic-messages", state: "completed" },
    } as never)
    chunks.length = 0 // only inspect the render simulating the next footer-timer tick

    // `viewingId !== ctx.id` (bbbbbbbb is viewed, aaaaaaaa terminated) so
    // `onTerminal` does NOT call `exitDetail()` — detail stays open on
    // bbbbbbbb. `printLog`'s `detailActive` guard queues aaaaaaaa's log line
    // and returns without rendering, so drive the next render the same way a
    // footer-timer tick would: `up` is inert in the reducer's `detail` case,
    // isolating this to "which entry does the NEXT repaint resolve" — not
    // "did this keypress change the selection".
    stdin.emit("data", Buffer.from([0x1b, 0x5b, 0x41])) // \x1b[A (up arrow), no-op in detail
    const out = chunks.join("")
    expect(out).toContain("req_id: bbbbbbbb") // still viewing the SAME request (id-based lookup)
    expect(out).not.toContain("req_id: cccccccc") // never silently drifted to the entry that shifted into the old index
    ui.destroy()
  })
})
