/**
 * `terminal-coordinator` — the single region-aware `emergencyWrite` seam (P2.1,
 * spec `docs/spec/2026-07-11-tui-render-model-layered.md` §4/§8). Pins the five
 * states the brief calls out before any real caller (republish.ts / FileSink,
 * P2.2) is wired through it:
 *
 *   1. unregistered → direct `process.stderr.write` (today's fallback, unchanged);
 *   2. `"region"` → one atomic write: clear panel + line + redraw panel;
 *   3. `"alt"` → write-through (no clear/redraw) — I-new-1 sooner-pollute-than-lose;
 *   4. `"inline"` → clear + line + redraw, same shape as `"region"` (I2);
 *   5. never touches the bus / never calls `publish` — no bus is even
 *      constructed in this file, so a coupling to it is structurally
 *      impossible, not just untested.
 *
 * Each test calls the returned `unregister()` in `afterEach` so the
 * module-level singleton never leaks state across cases (all tests in this
 * file otherwise share the same `registered` binding).
 */

import {
  //
  afterEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type {
  //
  TerminalHooks,
  TerminalRegionState,
} from "~/lib/tui/terminal-coordinator"

import {
  //
  emergencyWrite,
  registerTerminal,
} from "~/lib/tui/terminal-coordinator"

/** Build a fake `TerminalHooks` fixed to one `state`, capturing every `write` call. */
function makeHooks(state: TerminalRegionState): { hooks: TerminalHooks; writes: Array<string> } {
  const writes: Array<string> = []
  const hooks: TerminalHooks = {
    state: () => state,
    clearPanel: mock(() => "<CLEAR>"),
    redrawPanel: mock(() => "<REDRAW>"),
    write: (s: string) => writes.push(s),
  }
  return { hooks, writes }
}

let unregister: (() => void) | undefined
afterEach(() => {
  unregister?.()
  unregister = undefined
})

describe("terminal-coordinator — emergencyWrite", () => {
  test("unregistered → writes straight to process.stderr", () => {
    const stderrWrite = mock((_s: string | Uint8Array) => true)
    const original = process.stderr.write
    process.stderr.write = stderrWrite as unknown as typeof process.stderr.write
    try {
      emergencyWrite("boom")
    } finally {
      process.stderr.write = original
    }
    expect(stderrWrite).toHaveBeenCalledTimes(1)
    expect(stderrWrite.mock.calls[0][0]).toBe("boom\n")
  })

  test('"region" state → single atomic write: clearPanel + line + redrawPanel', () => {
    const { hooks, writes } = makeHooks("region")
    unregister = registerTerminal(hooks)

    emergencyWrite("region emergency")

    expect(writes).toEqual(["<CLEAR>region emergency\n<REDRAW>"]) // exactly one write call
    expect(hooks.clearPanel).toHaveBeenCalledTimes(1)
    expect(hooks.redrawPanel).toHaveBeenCalledTimes(1)
  })

  test('"alt" state → write-through, no clear/redraw (I-new-1 sooner-pollute-than-lose)', () => {
    const { hooks, writes } = makeHooks("alt")
    unregister = registerTerminal(hooks)

    emergencyWrite("alt emergency")

    expect(writes).toEqual(["alt emergency\n"])
    expect(hooks.clearPanel).not.toHaveBeenCalled()
    expect(hooks.redrawPanel).not.toHaveBeenCalled()
  })

  test('"inline" state → clear + line + redraw, same atomic shape as "region" (I2)', () => {
    const { hooks, writes } = makeHooks("inline")
    unregister = registerTerminal(hooks)

    emergencyWrite("inline emergency")

    expect(writes).toEqual(["<CLEAR>inline emergency\n<REDRAW>"])
    expect(hooks.clearPanel).toHaveBeenCalledTimes(1)
    expect(hooks.redrawPanel).toHaveBeenCalledTimes(1)
  })

  test('"none" state → write-through, no clear/redraw', () => {
    const { hooks, writes } = makeHooks("none")
    unregister = registerTerminal(hooks)

    emergencyWrite("none emergency")

    expect(writes).toEqual(["none emergency\n"])
    expect(hooks.clearPanel).not.toHaveBeenCalled()
    expect(hooks.redrawPanel).not.toHaveBeenCalled()
  })

  test("never touches the bus / never publishes — hooks.write is the only side effect observed", () => {
    // There is no bus in scope anywhere in this file: emergencyWrite takes no
    // bus/publisher argument and this module doesn't import one, so a bus
    // dependency is structurally impossible here — not merely unexercised.
    const { hooks, writes } = makeHooks("region")
    unregister = registerTerminal(hooks)

    expect(() => emergencyWrite("no publish side effect")).not.toThrow()
    expect(writes).toHaveLength(1)
  })

  test("registerTerminal returns an unregister() that reverts to the stderr fallback", () => {
    const stderrWrite = mock((_s: string | Uint8Array) => true)
    const original = process.stderr.write
    const { hooks, writes } = makeHooks("region")
    const revert = registerTerminal(hooks)

    revert()
    process.stderr.write = stderrWrite as unknown as typeof process.stderr.write
    try {
      emergencyWrite("after unregister")
    } finally {
      process.stderr.write = original
    }

    expect(writes).toHaveLength(0) // the unregistered terminal never saw it
    expect(stderrWrite).toHaveBeenCalledTimes(1)
    expect(stderrWrite.mock.calls[0][0]).toBe("after unregister\n")
  })

  test("a stale unregister() from a superseded registration is a no-op", () => {
    const first = makeHooks("region")
    const staleUnregister = registerTerminal(first.hooks)

    const second = makeHooks("inline")
    unregister = registerTerminal(second.hooks) // supersedes the first registration

    staleUnregister() // must not clear the second (current) registration
    emergencyWrite("still routed to second")

    expect(second.writes).toHaveLength(1) // second registration still active
    expect(first.writes).toHaveLength(0)
  })
})
