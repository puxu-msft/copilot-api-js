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
  selectedIndex,
} from "~/lib/tui/controller"

const IDS = Array.from({ length: 10 }, (_, index) => `r${index}`)
const CTX = { activeIds: IDS, visibleRows: 5 }
function drive(keys: Array<KeyEvent>, initial: UiState = INITIAL_UI_STATE): UiState {
  return keys.reduce((state, key) => reduce(state, key, CTX), initial)
}
const down: KeyEvent = { kind: "down" }
const up: KeyEvent = { kind: "up" }

describe("ID-based UI reducer", () => {
  test("initial state has no index truth", () => {
    expect(INITIAL_UI_STATE).toEqual({ view: "collapsed", scrollOffset: 0, detailScrollOffset: 0, showHelp: false })
  })
  test("panel navigation stores selectedRequestId and derives index", () => {
    const state = drive([{ kind: "space" }, down, down, up])
    expect(state.selectedRequestId).toBe("r1")
    expect(selectedIndex(state, IDS)).toBe(1)
  })
  test("navigation clamps and scroll follows the selected id", () => {
    const state = drive([{ kind: "space" }, ...Array(12).fill(down)])
    expect(state.selectedRequestId).toBe("r9")
    expect(state.scrollOffset).toBe(5)
    const back = Array(6)
      .fill(up)
      .reduce((current, key) => reduce(current, key, CTX), state)
    expect(back.selectedRequestId).toBe("r3")
    expect(back.scrollOffset).toBe(3)
  })
  test("detail stores detailRequestId and escape clears it", () => {
    const detail = drive([{ kind: "space" }, down, { kind: "enter" }])
    expect(detail.view).toBe("detail")
    expect(detail.detailRequestId).toBe("r1")
    const panel = reduce(detail, { kind: "escape" }, CTX)
    expect(panel.view).toBe("panel")
    expect(panel.detailRequestId).toBeUndefined()
  })
  test("detail viewport keys and help are pure transitions", () => {
    const detail = drive([{ kind: "space" }, { kind: "enter" }])
    expect(reduce(detail, { kind: "page-down" }, CTX).detailScrollOffset).toBe(5)
    expect(reduce(detail, { kind: "end" }, CTX).detailScrollOffset).toBe(Number.MAX_SAFE_INTEGER)
    expect(reduce(INITIAL_UI_STATE, { kind: "help" }, CTX).showHelp).toBe(true)
  })
  test("generic char and ctrl-c are no-ops", () => {
    const panel = drive([{ kind: "space" }, down])
    expect(reduce(panel, { kind: "char", char: "x" }, CTX)).toEqual(panel)
    expect(reduce(panel, { kind: "ctrl-c" }, CTX)).toEqual(panel)
  })
})
