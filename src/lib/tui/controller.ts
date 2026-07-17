/**
 * `controller.ts` — pure UI state machine for the interactive TUI (P1 panel).
 *
 * The last side-effect-free leaf of the read-only interactive TUI: a reducer
 * that maps `(state, key, ctx)` to the next {@link UiState} with no I/O and no
 * mutation of the input state. The terminal-ui layer owns rendering and stdin;
 * it feeds each decoded {@link KeyEvent} through {@link reduce} and re-renders
 * from the returned state. Keeping the transition logic here — pure and
 * deterministic — makes it exhaustively unit-testable without a terminal.
 *
 * View model (three nested panes):
 *
 *   - `collapsed` — the idle single-line footer; `space`/`tab` opens the panel;
 *   - `panel` — the scrollable request list; `up`/`down` move the selection
 *     (with the visible window following), `enter` drills into `detail`,
 *     `space`/`tab` collapses back, `escape` collapses back;
 *   - `detail` — a single request's detail; `escape` returns to `panel`.
 *
 * `escape` steps back one level (detail → panel → collapsed). `help` (`?`)
 * toggles the help overlay from any view.
 *
 * P1 is strictly read-only: the destructive `x` (abort) and `c` (copy) actions,
 * and any other `char`, are intentional no-ops here — they are deferred to P2.
 * `ctrl-c` is likewise not this reducer's concern: terminal-ui forwards it to
 * tear the UI down, so `reduce` leaves the state unchanged.
 */

import type { KeyEvent } from "./input/keys"

/** The complete, immutable UI state driven by {@link reduce}. */
export type UiState = {
  /** Which of the three nested panes is active. */
  view: "collapsed" | "panel" | "detail"
  /** Index of the highlighted request row (clamped to `[0, activeCount-1]`). */
  selectedIndex: number
  /** Index of the first visible row — the top of the scroll window. */
  scrollOffset: number
  /** Top row of the detail document viewport. */
  detailScrollOffset: number
  /** Whether the help overlay is shown. */
  showHelp: boolean
}

/** Ambient dimensions the reducer needs to clamp selection and scrolling. */
export type UiContext = {
  /** Number of active requests currently in the list. */
  activeCount: number
  /** Number of request rows the panel can display at once. */
  visibleRows: number
}

/** The pane state a freshly attached TUI starts in: collapsed, nothing shown. */
export const INITIAL_UI_STATE: UiState = {
  view: "collapsed",
  selectedIndex: 0,
  scrollOffset: 0,
  detailScrollOffset: 0,
  showHelp: false,
}

/** Clamp `value` into the inclusive range `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Recompute the scroll window's top so `selectedIndex` stays visible.
 *
 * RFC §6 overflow scroll: if the selection moved above the window, snap the
 * window up to it; if it moved below the window's last visible row, snap the
 * window down so the selection sits on that last row. Otherwise the window is
 * unchanged.
 */
function scrollToShow(selectedIndex: number, scrollOffset: number, visibleRows: number): number {
  if (selectedIndex < scrollOffset) return selectedIndex
  if (selectedIndex >= scrollOffset + visibleRows) {
    return selectedIndex - visibleRows + 1
  }
  return scrollOffset
}

/**
 * Advance the UI state machine by one key event. Pure: the returned state is a
 * new object on every transition and the input `state` is never mutated.
 * Unrecognized `(view, key)` pairs (including P1's deferred `x`/`c`/`char` and
 * the terminal-ui-owned `ctrl-c`) return the input `state` unchanged.
 */
export function reduce(state: UiState, key: KeyEvent, ctx: UiContext): UiState {
  // `help` toggles the overlay from any view.
  if (key.kind === "help") {
    return { ...state, showHelp: !state.showHelp }
  }

  switch (state.view) {
    case "collapsed": {
      // `space`/`tab` opens the panel; everything else is inert while idle.
      if (key.kind === "space" || key.kind === "tab") {
        return { ...state, view: "panel" }
      }
      return state
    }

    case "panel": {
      switch (key.kind) {
        case "up":
        case "down": {
          const delta = key.kind === "up" ? -1 : 1
          const selectedIndex = clamp(state.selectedIndex + delta, 0, ctx.activeCount - 1)
          const scrollOffset = scrollToShow(selectedIndex, state.scrollOffset, ctx.visibleRows)
          return { ...state, selectedIndex, scrollOffset }
        }
        case "enter": {
          return { ...state, view: "detail", detailScrollOffset: 0 }
        }
        case "space":
        case "tab": {
          return { ...state, view: "collapsed" }
        }
        case "escape": {
          return { ...state, view: "collapsed" }
        }
        default: {
          // P1 read-only: `x`/`c`/`char`, `ctrl-c` — no-op.
          return state
        }
      }
    }

    case "detail": {
      // `escape` steps back to the panel; other keys are inert in detail.
      if (key.kind === "escape") {
        return { ...state, view: "panel" }
      }
      if (key.kind === "home") return { ...state, detailScrollOffset: 0 }
      if (key.kind === "up") return { ...state, detailScrollOffset: Math.max(0, state.detailScrollOffset - 1) }
      if (key.kind === "page-up") return { ...state, detailScrollOffset: Math.max(0, state.detailScrollOffset - Math.max(1, ctx.visibleRows)) }
      if (key.kind === "down") return { ...state, detailScrollOffset: state.detailScrollOffset + 1 }
      if (key.kind === "page-down") return { ...state, detailScrollOffset: state.detailScrollOffset + Math.max(1, ctx.visibleRows) }
      if (key.kind === "end") return { ...state, detailScrollOffset: Number.MAX_SAFE_INTEGER }
      return state
    }

    default: {
      return state
    }
  }
}
