/**
 * `reduce` — pure UI state machine for the interactive TUI (P1 read-only panel).
 *
 * The controller is the last leaf of the P1 TUI: a side-effect-free reducer
 * that maps `(state, key, ctx)` → next `UiState`, with no I/O and no mutation
 * of the input state. These assertions pin the view-transition and
 * selection/scroll rules the terminal-ui layer drives on each key event:
 *
 *   - `collapsed` + `space`/`tab` → `panel` (and the reverse toggle);
 *   - `panel` + `up`/`down` moves `selectedIndex`, clamped to
 *     `[0, activeCount-1]`, with `scrollOffset` following so the selection
 *     stays inside the visible window (RFC §6 overflow scroll);
 *   - `panel` + `enter` → `detail`; `escape` steps back
 *     detail → panel → collapsed;
 *   - `help` (`?`) flips `showHelp`;
 *   - P1 is read-only: `x`/`c`/`char` are no-ops (deferred to P2); `ctrl-c` is
 *     forwarded/handled by terminal-ui, not here, so `reduce` leaves state as-is.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { UiState } from "~/lib/tui/controller"
import type { KeyEvent } from "~/lib/tui/input/keys"

import {
  //
  INITIAL_UI_STATE,
  reduce,
} from "~/lib/tui/controller"

const CTX = { activeCount: 10, visibleRows: 5 }

/** Fold a key sequence through `reduce`, starting from `INITIAL_UI_STATE`. */
function drive(keys: Array<KeyEvent>, ctx: { activeCount: number; visibleRows: number } = CTX, initial: UiState = INITIAL_UI_STATE): UiState {
  return keys.reduce((state, key) => reduce(state, key, ctx), initial)
}

const up: KeyEvent = { kind: "up" }
const down: KeyEvent = { kind: "down" }

describe("reduce — UI state machine", () => {
  test("INITIAL_UI_STATE is collapsed at the top with help hidden", () => {
    expect(INITIAL_UI_STATE).toEqual({
      view: "collapsed",
      selectedIndex: 0,
      scrollOffset: 0,
      detailScrollOffset: 0,
      showHelp: false,
    })
  })

  test("collapsed + space → panel", () => {
    expect(drive([{ kind: "space" }]).view).toBe("panel")
  })

  test("collapsed + tab → panel", () => {
    expect(drive([{ kind: "tab" }]).view).toBe("panel")
  })

  test("panel + space → collapsed (toggle back)", () => {
    expect(drive([{ kind: "space" }, { kind: "space" }]).view).toBe("collapsed")
  })

  test("panel + tab → collapsed (toggle back)", () => {
    expect(drive([{ kind: "tab" }, { kind: "tab" }]).view).toBe("collapsed")
  })

  test("panel + down moves selectedIndex forward", () => {
    const s = drive([{ kind: "space" }, down])
    expect(s.view).toBe("panel")
    expect(s.selectedIndex).toBe(1)
  })

  test("panel + up moves selectedIndex back", () => {
    const s = drive([{ kind: "space" }, down, down, up])
    expect(s.selectedIndex).toBe(1)
  })

  test("up clamps at lower bound 0 (does not go negative)", () => {
    const s = drive([{ kind: "space" }, up, up, up])
    expect(s.selectedIndex).toBe(0)
  })

  test("down clamps at upper bound activeCount-1", () => {
    // 12 downs against activeCount=10 → selectedIndex pinned at 9.
    const s = drive([{ kind: "space" }, ...Array(12).fill(down)])
    expect(s.selectedIndex).toBe(9)
  })

  test("scrollOffset stays 0 while selection is inside the first window", () => {
    // visibleRows=5 → indices 0..4 need no scroll.
    const s = drive([{ kind: "space" }, down, down, down, down])
    expect(s.selectedIndex).toBe(4)
    expect(s.scrollOffset).toBe(0)
  })

  test("scrollOffset follows when selection crosses below the window", () => {
    // 5th down lands on index 5, one past the window bottom (0..4).
    const s = drive([{ kind: "space" }, down, down, down, down, down])
    expect(s.selectedIndex).toBe(5)
    expect(s.scrollOffset).toBe(1) // 5 - 5 + 1
  })

  test("selecting the last row scrolls the window to the bottom", () => {
    const s = drive([{ kind: "space" }, ...Array(12).fill(down)])
    expect(s.selectedIndex).toBe(9)
    expect(s.scrollOffset).toBe(5) // 9 - 5 + 1 → shows rows 5..9
  })

  test("scrollOffset snaps up when selection crosses above the window", () => {
    // Scroll to the bottom, then walk back up past the window top.
    const bottom = drive([{ kind: "space" }, ...Array(12).fill(down)])
    expect(bottom.scrollOffset).toBe(5)
    const back = [up, up, up, up, up, up].reduce((state, key) => reduce(state, key, CTX), bottom)
    // selectedIndex 9 → 3; 3 < scrollOffset(5) → scrollOffset snaps to 3.
    expect(back.selectedIndex).toBe(3)
    expect(back.scrollOffset).toBe(3)
  })

  test("panel + enter → detail", () => {
    expect(drive([{ kind: "space" }, { kind: "enter" }]).view).toBe("detail")
  })

  test("escape steps back detail → panel → collapsed", () => {
    const detail = drive([{ kind: "space" }, { kind: "enter" }])
    expect(detail.view).toBe("detail")
    const panel = reduce(detail, { kind: "escape" }, CTX)
    expect(panel.view).toBe("panel")
    const collapsed = reduce(panel, { kind: "escape" }, CTX)
    expect(collapsed.view).toBe("collapsed")
  })

  test("help (?) flips showHelp", () => {
    const shown = drive([{ kind: "help" }])
    expect(shown.showHelp).toBe(true)
    const hidden = reduce(shown, { kind: "help" }, CTX)
    expect(hidden.showHelp).toBe(false)
  })

  test("P1 read-only: 'x' is a no-op (state unchanged)", () => {
    const panel = drive([{ kind: "space" }, down, down])
    const after = reduce(panel, { kind: "char", char: "x" }, CTX)
    expect(after).toEqual(panel)
  })

  test("P1 read-only: 'c' is a no-op (state unchanged)", () => {
    const panel = drive([{ kind: "space" }, down])
    const after = reduce(panel, { kind: "char", char: "c" }, CTX)
    expect(after).toEqual(panel)
  })

  test("generic char is a no-op (state unchanged)", () => {
    const panel = drive([{ kind: "space" }])
    const after = reduce(panel, { kind: "char", char: "q" }, CTX)
    expect(after).toEqual(panel)
  })

  test("ctrl-c is not handled by reduce (state unchanged)", () => {
    const panel = drive([{ kind: "space" }, down])
    const after = reduce(panel, { kind: "ctrl-c" }, CTX)
    expect(after).toEqual(panel)
  })

  test("reduce does not mutate the input state", () => {
    const before: UiState = { ...INITIAL_UI_STATE }
    reduce(before, { kind: "space" }, CTX)
    expect(before).toEqual(INITIAL_UI_STATE)
  })

  test("up/down are no-ops in collapsed and scroll detail", () => {
    expect(reduce(INITIAL_UI_STATE, down, CTX)).toEqual(INITIAL_UI_STATE)
    const detail = drive([{ kind: "space" }, { kind: "enter" }])
    expect(reduce(detail, down, CTX).detailScrollOffset).toBe(1)
  })
})
