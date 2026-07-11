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
 *   - `escape ×2` → back to collapsed; the region is now constant-height
 *     (spec INV-2), so the round-trip does NOT re-emit the DECSTBM reset
 *     `\x1b[r` (BLOCK-1 seam: collapsed↔panel↔collapsed round-trip is zero
 *     churn — same scroll-region geometry throughout);
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

import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

const NOW = 1_700_000_000_000

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

    // ⑤ escape ×2 → detail → panel → collapsed. Constant-height (spec INV-2):
    //    collapsed is now padded to the same panel height as `panel`, so the
    //    shrink-back does NOT re-issue the DECSTBM reset — zero-churn geometry
    //    across the whole collapsed↔panel↔collapsed round-trip.
    stdin.emit("data", Buffer.from([0x1b])) // escape → panel
    mark = since()
    stdin.emit("data", Buffer.from([0x1b])) // escape → collapsed (constant height, no resize)
    const collapseOut = sliceFrom(mark)
    expect(collapseOut).not.toContain(SCROLL_RESET) // no DECSTBM reset — geometry unchanged

    // ⑥ ctrl-c → injected shutdown signal.
    stdin.emit("data", Buffer.from([0x03]))
    expect(onShutdownSignal).toHaveBeenCalledWith("SIGINT")

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

  test("constant geometry: collapsed↔panel toggle never resizes the DECSTBM region", () => {
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
    // Trigger a collapsed render synchronously (the footer timer is async) via
    // `system.log` → `printLog` → `renderRegion` — the existing golden-test
    // technique, rather than adding a render-only test hook.
    bus.scope("system").publish({ kind: "system.log", logType: "info", message: "x", time: Date.now() } as never)
    chunks.length = 0
    stdin.emit("data", Buffer.from(" ")) // collapsed → panel
    stdin.emit("data", Buffer.from(" ")) // panel → collapsed
    const bottoms = new Set(
      // eslint-disable-next-line no-control-regex -- intentional ESC control char
      [...chunks.join("").matchAll(/\x1b\[1;(\d+)r/g)].map((m) => m[1]),
    )
    expect(bottoms.size).toBe(1) // constant geometry — collapsed no longer shrinks the region
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
    bus.scope("system").publish({ kind: "system.log", logType: "info", message: "concurrent", time: Date.now() } as never)
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

  test("INV-1: collapsed→panel→collapsed round-trip does not overwrite prior log rows", () => {
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
    bus.scope("system").publish({ kind: "system.log", logType: "info", message: "SENTINEL", time: Date.now() } as never)
    chunks.length = 0
    stdin.emit("data", Buffer.from(" ")) // → panel
    stdin.emit("data", Buffer.from(" ")) // → collapsed
    const out = chunks.join("")
    // Positive sample: the panel must never overwrite the log row where
    // SENTINEL landed. Under constant geometry the panel only ever paints the
    // bottom 3 rows — the discriminating assertion is that every absolute
    // cursor positioning (CUP) target during the round-trip stays within the
    // protected bottom panel rows (>= panelTop), never walking back into the
    // scrolling log region above it.
    // eslint-disable-next-line no-control-regex -- intentional ESC control char
    const cups = [...out.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1]))
    // rows=24, panelHeight=3 → panel rows are only 22/23/24; any row < 22
    // would mean a CUP+clear reached back into the log region.
    expect(cups.every((row) => row >= 22)).toBe(true) // mutation: a round-trip resize clearing log rows → row<22 → red
    ui.destroy()
  })
})
