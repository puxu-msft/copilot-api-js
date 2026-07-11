/**
 * `Region` — DECSTBM sticky bottom multi-line panel renderer (P1 interactive
 * TUI, load-bearing render primitive).
 *
 * Ported from the byte-level verified PoC `exp/tui-rawmode/sticky-region-decstbm.ts`
 * (PoC-2b, confirmed in a real terminal). DECSTBM (`\x1b[<top>;<bottom>r`) sets a
 * scroll region: log lines printed inside the top region scroll only within it,
 * while the reserved bottom N lines are a panel that native scroll never
 * disturbs — the same mechanism tmux/htop-style bottom bars use to survive
 * scrollback. The alternative relative-cursor approach (`\x1b[NF`) mis-anchors
 * once a bottom write triggers a full-screen scroll; DECSTBM does not.
 *
 * Scope: this class owns **only** cursor/scroll-region choreography. It draws
 * whatever `lines` it is handed — each already a pure presentation string of
 * width ≤ columns-1 (the caller truncates). No business logic, no wall clock,
 * no width math beyond the vertical clamp.
 *
 * Cursor contract (load-bearing): after `render`, the cursor is parked back
 * inside the scroll region via DECRC (`\x1b8`), so the sink's `printLog` writes
 * its next log line at the correct spot inside the scrolling area — never over
 * the panel.
 */

import { truncateToWidth } from "~/lib/observability/projections/format"

/**
 * Rows kept for the scrolling log area above the panel. The panel is clamped so
 * at least this many rows remain for logs; without it a tall panel could claim
 * the whole screen (or spill off the top). One row is the floor — a sticky
 * panel is pointless if no log line can ever show.
 */
export const RESERVED_LOG_ROWS = 1

/** DECSTBM: set scroll region to rows `top..bottom` (1-based, inclusive). */
const setScrollRegion = (top: number, bottom: number): string => `\x1b[${top};${bottom}r`
/** DECSTBM reset: scroll region back to the full screen. */
const RESET_SCROLL_REGION = "\x1b[r"
/** Move cursor to (row, col=1), 1-based absolute. */
const cursorTo = (row: number): string => `\x1b[${row};1H`
/** Erase the entire current line. */
const CLEAR_LINE = "\x1b[2K"
/** Erase from the cursor to the end of the screen. */
const ERASE_TO_END = "\x1b[0J"
/** DECSC / DECRC: save / restore cursor position. */
const SAVE_CURSOR = "\x1b7"
const RESTORE_CURSOR = "\x1b8"
/** Hide / show the cursor. */
const HIDE_CURSOR = "\x1b[?25l"
const SHOW_CURSOR = "\x1b[?25h"

export interface RegionOptions {
  stdout: NodeJS.WritableStream
  /** Current terminal width in columns (queried each `render`). */
  getColumns: () => number
  /** Current terminal height in rows (queried each `render`, drives re-anchor). */
  getRows: () => number
}

export class Region {
  private readonly stdout: NodeJS.WritableStream
  private readonly getColumns: () => number
  private readonly getRows: () => number

  /**
   * The scroll region currently established on the terminal, or `undefined`
   * when none is set (initial state, or after `clear()` / an empty `render`).
   * Tracks the `rows`/`panelHeight` the DECSTBM was set for so we only re-issue
   * the scroll region when the geometry actually changes (resize / N change),
   * and so we can clean up the old panel's orphan rows on re-anchor.
   */
  private established?: { rows: number; panelHeight: number }

  constructor(opts: RegionOptions) {
    this.stdout = opts.stdout
    this.getColumns = opts.getColumns
    this.getRows = opts.getRows
  }

  /**
   * Draw `lines` as the sticky bottom panel. `lines` are pure presentation
   * strings, each already ≤ columns-1 wide. Vertically clamps to
   * `min(lines.length, rows - RESERVED_LOG_ROWS)`; when clamped, the last panel
   * row becomes a `+K more below` indicator. Re-establishes DECSTBM on first
   * draw or whenever the terminal height / panel height changed (resize), first
   * tearing down the previous region so no orphan rows are left behind.
   *
   * Ends with the cursor parked inside the scroll region (DECRC) — the printLog
   * landing contract.
   */
  render(lines: ReadonlyArray<string>): void {
    // Defensive width guard: a panel line wider than the terminal auto-wraps,
    // which corrupts the absolute row anchoring the whole DECSTBM scheme relies
    // on. Callers already truncate to ≤ columns-1, so this is a no-op for
    // well-formed input; the `-1` avoids the last-column auto-wrap some
    // terminals do.
    const cols = this.getColumns()
    const clampWidth = (s: string): string => truncateToWidth(s, cols - 1)

    const rows = this.getRows()
    const maxPanel = Math.max(0, rows - RESERVED_LOG_ROWS)
    const panelHeight = Math.min(lines.length, maxPanel)

    // Nothing to show (empty input, or no room): fully collapse the region.
    if (panelHeight <= 0) {
      this.clear()
      return
    }

    const prev = this.established
    const geometryChanged = !prev || prev.rows !== rows || prev.panelHeight !== panelHeight

    let out = ""

    if (geometryChanged) {
      if (prev) {
        // Re-anchor: tear down the old scroll region and wipe its orphan panel
        // rows before setting the new one, else stale panel content lingers at
        // the old bottom after a resize.
        out += RESET_SCROLL_REGION
        const oldPanelTop = prev.rows - prev.panelHeight + 1
        for (let i = 0; i < prev.panelHeight; i++) {
          out += cursorTo(oldPanelTop + i) + CLEAR_LINE
        }
      } else {
        // First establish: hide the cursor for the panel's lifetime (restored
        // by clear()).
        out += HIDE_CURSOR
      }
      const bottom = rows - panelHeight
      out += setScrollRegion(1, bottom)
      // DECSTBM homes the cursor to page (1,1) = the scroll region's TOP row
      // (VT510). Left there, the DECSC below would save the top row and the
      // closing DECRC would park the cursor at the top — so printLog's first
      // log lines land at screen top instead of tailing the panel. Move into
      // the scroll region's BOTTOM row so DECSC/DECRC park there (PoC line 58,
      // `exp/tui-rawmode/sticky-region-decstbm.ts` "move into scroll region").
      out += cursorTo(bottom)
      this.established = { rows, panelHeight }
    } else {
      // fix A (spec INV-4): re-assert DECSTBM even when geometry is unchanged,
      // so any unexpected disturbance (a bypass write, a terminal quirk) is
      // self-healed on the very next frame. SAVE_CURSOR/RESTORE_CURSOR (DECSC/
      // DECRC) bracket it to absorb DECSTBM's cursor-home side effect (VT510) —
      // the cursor never visibly moves, no flicker, and re-issuing the same
      // region is idempotent.
      const bottom = rows - panelHeight
      out += SAVE_CURSOR + setScrollRegion(1, bottom) + RESTORE_CURSOR
    }

    // Draw the panel. DECSC before, DECRC after, so the cursor returns to
    // wherever the scroll region left it (printLog contract).
    out += SAVE_CURSOR
    const panelTop = rows - panelHeight + 1
    const overflow = lines.length > panelHeight
    for (let i = 0; i < panelHeight; i++) {
      out += cursorTo(panelTop + i) + CLEAR_LINE
      const isLast = i === panelHeight - 1
      if (isLast && overflow) {
        // K = lines not shown = total - (panelHeight - 1 content rows shown).
        const hidden = lines.length - (panelHeight - 1)
        out += clampWidth(`+${hidden} more below`)
      } else {
        out += clampWidth(lines[i])
      }
    }
    out += RESTORE_CURSOR

    this.stdout.write(out)
  }

  /**
   * Tear down the panel: reset the scroll region to the full screen, **erase the
   * panel's rows**, park the cursor directly below the last log line, and show
   * the cursor. Resets internal state so the next `render` re-establishes DECSTBM
   * from scratch. Idempotent — safe to call when no region is established.
   *
   * Erasing + repositioning is load-bearing: `RESET_SCROLL_REGION` alone leaves
   * the cursor mid-screen (parked at the old scroll-region bottom by the last
   * render's DECRC) with the stale panel rows still drawn below. Subsequent
   * output — shutdown logs, the shell prompt after Ctrl-C — would then start
   * mid-screen and overwrite downward, with panel remnants lingering. Instead we
   * move to the panel's top row (`panelTop`, one below the scroll region's last
   * log line), `\x1b[0J` erases from there to end of screen (the whole panel),
   * and the cursor stays there so output continues cleanly at the bottom.
   *
   * The `established` guard makes a repeat `clear()` a genuine no-op: an idle
   * interactive session funnels every `printLog` through `renderRegion → empty
   * lines → clear()`; without the guard each would re-emit the teardown even
   * though the panel is already gone. The first collapse still emits exactly one.
   */
  clear(): void {
    if (!this.established) return
    const { rows, panelHeight } = this.established
    const panelTop = rows - panelHeight + 1
    // Reset scroll region → move to the panel's top (just below the last log) →
    // erase to end of screen (wipes the panel) → show cursor, leaving it there.
    this.stdout.write(RESET_SCROLL_REGION + cursorTo(panelTop) + ERASE_TO_END + SHOW_CURSOR)
    this.established = undefined
  }
}
