/**
 * Cross-component scroll-alignment regression (F3): the window `buildPanelLines`
 * slices MUST equal the window `reduce`'s scroll math assumes. Both derive their
 * row count from the SAME `panelContentRows(totalRows, activeCount, showHelp)` —
 * this test drives real reduce-navigation and asserts the selected request stays
 * inside the rendered window, so a future drift on either side is caught.
 *
 * The load-bearing invariant: after any reduce-driven navigation, the selected
 * row is visible (reverse-video present) in `buildPanelLines`'s output.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { KeyEvent } from "~/lib/tui/input/keys"
import type { DetailView } from "~/lib/tui/render/panel"

import {
  //
  INITIAL_UI_STATE,
  reduce,
  selectedIndex,
  type UiState,
} from "~/lib/tui/controller"
import {
  //
  buildPanelLines,
  panelContentRows,
} from "~/lib/tui/render/panel"

const NOW = 1_700_000_000_000
const REVERSE_ON = "\x1b[7m"

function views(n: number): Array<DetailView> {
  return Array.from({ length: n }, (_, i) => ({
    ctx: {
      id: `req_${i}`,
      endpoint: "anthropic-messages" as const,
      method: "POST",
      path: `/v1/messages/${i}`,
      resolvedModel: "m",
      state: "streaming" as const,
      startTime: NOW - 1000,
      queueWaitMs: 0,
    },
  }))
}

/** Open the panel, then press `down` `steps` times, with visibleRows kept in
 *  lockstep with `panelContentRows` (exactly what terminal-ui feeds reduce). */
function navigate(activeCount: number, rows: number, showHelp: boolean, steps: number): UiState {
  const keys: Array<KeyEvent> = [
    { kind: "space" },
    ...(showHelp ? [{ kind: "help" } as KeyEvent] : []),
    ...Array.from<unknown, KeyEvent>({ length: steps }, () => ({ kind: "down" })),
  ]
  const activeIds = views(activeCount).map((view) => view.ctx.id)
  return keys.reduce((state, key) => {
    const visibleRows = panelContentRows(rows, activeCount, state.showHelp)
    return reduce(state, key, { activeIds, visibleRows })
  }, INITIAL_UI_STATE)
}

describe("panel scroll alignment (controller ↔ buildPanelLines)", () => {
  for (const activeCount of [4, 10, 30]) {
    for (const rows of [10, 24]) {
      test(`selected row stays visible across nav (active=${activeCount}, rows=${rows})`, () => {
        const active = views(activeCount)
        // Walk the whole list one row at a time; at every step the rendered
        // window must contain the selected row.
        const activeIds = active.map((view) => view.ctx.id)
        let state: UiState = { ...INITIAL_UI_STATE, view: "panel", selectedRequestId: activeIds[0] }
        for (let step = 0; step <= activeCount + 2; step++) {
          const lines = buildPanelLines({
            active,
            now: NOW,
            columns: 100,
            selectedIndex: selectedIndex(state, activeIds),
            scrollOffset: state.scrollOffset,
            rows,
            showHelp: false,
          })
          // Exactly one content row carries the reverse-video selection marker.
          const reversed = lines.filter((l) => l.includes(REVERSE_ON))
          expect(reversed.length).toBe(1)
          // Advance one row (visibleRows in lockstep with the renderer).
          const visibleRows = panelContentRows(rows, activeCount, false)
          state = reduce(state, { kind: "down" }, { activeIds, visibleRows })
        }
      })
    }
  }

  test("terminal-ui's help-navigation path also keeps the selection visible", () => {
    // Regression companion to the interactive suite: a nav after opening help.
    const active = views(10)
    const state = navigate(10, 10, true, 6)
    const visibleRows = panelContentRows(10, 10, state.showHelp)
    const lines = buildPanelLines({
      active,
      now: NOW,
      columns: 100,
      selectedIndex: selectedIndex(
        state,
        active.map((view) => view.ctx.id),
      ),
      scrollOffset: state.scrollOffset,
      rows: 10,
      showHelp: state.showHelp,
    })
    const contentWindow = active.slice(state.scrollOffset, state.scrollOffset + visibleRows)
    // The selected global index maps into the rendered window.
    const index = selectedIndex(
      state,
      active.map((view) => view.ctx.id),
    )
    expect(index).toBeGreaterThanOrEqual(state.scrollOffset)
    expect(index).toBeLessThan(state.scrollOffset + visibleRows)
    expect(lines.some((l) => l.includes(REVERSE_ON))).toBe(true)
    expect(contentWindow.length).toBeGreaterThan(0)
  })
})
