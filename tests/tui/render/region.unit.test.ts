/**
 * `Region` — DECSTBM sticky bottom multi-line region renderer (P1 interactive
 * TUI, load-bearing render primitive). Ported from the byte-level verified PoC
 * `exp/tui-rawmode/sticky-region-decstbm.ts`.
 *
 * These assert the wire-level escape protocol against a fake stdout (write
 * capture) with fixed `columns`/`rows`, since the renderer's whole job is to
 * emit the exact DECSTBM sequence that pins a bottom panel without anchor
 * drift. Pins:
 *
 *   - `render(lines)` sets the scroll region (`\x1b[1;<rows-N>r`), positions +
 *     clears each panel row absolutely, and brackets the draw in DECSC/DECRC so
 *     the cursor ends parked back inside the scroll region (printLog contract);
 *   - a steady-state re-render with unchanged rows/N still re-asserts DECSTBM
 *     every frame (fix A self-heal: an unexpected disturbance recovers on the
 *     very next render, since the region is tracked but reasserted regardless);
 *   - shrinking `getRows()` re-anchors: old region is torn down (`\x1b[r`), the
 *     orphan panel rows are cleared, and a new DECSTBM is set at the new bottom;
 *   - vertical clamp: `N = min(lines.length, rows - RESERVED_LOG_ROWS)`; when
 *     lines overflow, the last panel row shows `+K more below` — a positive
 *     sample first proves the unclamped panel would spill past the top of the
 *     screen, then that the clamped panel fits;
 *   - `clear()` resets DECSTBM (`\x1b[r`) and shows the cursor (`\x1b[?25h`).
 */

import {
  //
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  Region,
  RESERVED_LOG_ROWS,
} from "~/lib/tui/render/region"

/** Fake stdout that records every `write` chunk for wire-level assertions. */
function makeStdout(): {
  stdout: NodeJS.WritableStream
  chunks: Array<string>
  all: () => string
} {
  const chunks: Array<string> = []
  const stdout = {
    write(chunk: string | Uint8Array): boolean {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
      return true
    },
  } as unknown as NodeJS.WritableStream
  return { stdout, chunks, all: () => chunks.join("") }
}

/** Count non-overlapping occurrences of a fixed substring. */
function countOf(haystack: string, needle: string): number {
  let n = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    n++
    i = haystack.indexOf(needle, i + needle.length)
  }
  return n
}

function makeRegion(cols: number, rowsRef: { rows: number }): { region: Region; io: ReturnType<typeof makeStdout> } {
  const io = makeStdout()
  const region = new Region({
    stdout: io.stdout,
    getColumns: () => cols,
    getRows: () => rowsRef.rows,
  })
  return { region, io }
}

describe("Region (DECSTBM sticky bottom panel)", () => {
  let rowsRef: { rows: number }

  beforeEach(() => {
    rowsRef = { rows: 24 }
  })

  test("render(['a','b']) sets DECSTBM, positions+clears each panel row, brackets in DECSC/DECRC", () => {
    const { region, io } = makeRegion(80, rowsRef)
    region.render(["a", "b"])
    const out = io.all()

    // N = 2, bottom = rows - N = 22, panelTop = rows - N + 1 = 23.
    expect(out).toContain("\x1b[1;22r") // DECSTBM: scroll region 1..(rows-N)
    expect(out).toContain("\x1b7") // DECSC save
    expect(out).toContain("\x1b8") // DECRC restore
    expect(out).toContain("\x1b[23;1H") // panel row 1 (23)
    expect(out).toContain("\x1b[24;1H") // panel row 2 (24 = bottom of screen)
    expect(out).toContain("a")
    expect(out).toContain("b")

    // First establish hides the cursor (symmetric with clear()'s show).
    expect(out).toContain("\x1b[?25l")

    // One clear-line per panel row on a fresh establish (no orphan yet).
    expect(countOf(out, "\x1b[2K")).toBe(2)

    // Cursor parked back in the scroll region: the draw ends with DECRC.
    expect(out.endsWith("\x1b8")).toBe(true)
  })

  test("parks the cursor at the scroll-region bottom row before DECSC (printLog tail contract)", () => {
    const { region, io } = makeRegion(80, rowsRef)
    region.render(["a", "b"])
    const out = io.all()

    // rows=24, N=2 → bottom = rows - N = 22. DECSTBM homes the cursor to the
    // page TOP row (1,1) (VT510); the port must then move it into the scroll
    // region's BOTTOM row so the DECSC/DECRC bracket saves+restores THAT row —
    // else printLog's first log lines land at screen top instead of tailing
    // the panel. Regression guard: without the cursorTo(bottom) step this
    // sequence never appears (bottom=22 is not a panel row — those are 23/24).
    const parkBottom = "\x1b[22;1H"
    expect(out).toContain(parkBottom)

    // Order: DECSTBM set → move to bottom row → DECSC save → draw → DECRC.
    const decstbm = out.indexOf("\x1b[1;22r")
    const parkIdx = out.indexOf(parkBottom)
    const saveIdx = out.indexOf("\x1b7")
    expect(decstbm).toBeGreaterThanOrEqual(0)
    expect(decstbm).toBeLessThan(parkIdx)
    expect(parkIdx).toBeLessThan(saveIdx)
  })

  test("panel with no overflow draws every line, no '+K more below'", () => {
    const { region, io } = makeRegion(80, rowsRef)
    region.render(["x", "y", "z"])
    const out = io.all()
    expect(out).toContain("x")
    expect(out).toContain("y")
    expect(out).toContain("z")
    expect(out).not.toContain("more below")
    expect(countOf(out, "\x1b[2K")).toBe(3) // N = 3
  })

  test("steady-state re-render with unchanged rows/N re-asserts DECSTBM (fix A self-heal)", () => {
    const { region, io } = makeRegion(80, rowsRef)
    region.render(["a", "b"])
    const mark = io.chunks.length
    region.render(["c", "d"]) // same N, same rows
    const second = io.chunks.slice(mark).join("")

    // fix A (spec INV-4): even though geometry is unchanged, DECSTBM is
    // re-asserted every render so an unexpected disturbance (a stray write, a
    // terminal quirk) self-heals on the very next frame.
    expect(second).toContain("\x1b[1;22r")
    // But it still redraws the panel content.
    expect(second).toContain("c")
    expect(second).toContain("d")
    expect(second.endsWith("\x1b8")).toBe(true)
  })

  test("fix A: a same-geometry re-render re-asserts the DECSTBM scroll region", () => {
    const { region, io } = makeRegion(80, rowsRef)
    region.render(["line-a"]) // first establish (geometryChanged=true)
    const mark = io.chunks.length
    region.render(["line-b"]) // same-geometry re-render
    const out = io.chunks.slice(mark).join("")
    // Positive sample: a same-geometry re-render must re-assert the scroll
    // region too, otherwise an unexpected disturbance could never self-heal.
    // rows=24, panelHeight=1 → bottom = rows - panelHeight = 23.
    expect(out).toContain("\x1b[1;23r")
  })

  test("shrinking getRows() re-anchors: tears down old region and sets new DECSTBM at new bottom", () => {
    const { region, io } = makeRegion(80, rowsRef)
    region.render(["a", "b"]) // rows=24 → bottom=22
    const mark = io.chunks.length

    rowsRef.rows = 10
    region.render(["a", "b"]) // rows=10 → bottom=8
    const second = io.chunks.slice(mark).join("")

    expect(second).toContain("\x1b[r") // reset old scroll region (teardown)
    expect(second).toContain("\x1b[1;8r") // new DECSTBM at new bottom
    // Orphan old panel rows (23, 24) are cleared during re-anchor.
    expect(second).toContain("\x1b[23;1H")
    expect(second).toContain("\x1b[24;1H")
    expect(second.endsWith("\x1b8")).toBe(true)
  })

  test("vertical clamp: overflow shows '+K more below' and panel fits above the top", () => {
    rowsRef = { rows: 6 }
    const cols = 80
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`)

    // Positive sample: WITHOUT clamping, an N=10 panel on a 6-row screen would
    // start at row (rows - N + 1) = -3 — spilling off the top of the screen.
    const unclampedPanelTop = rowsRef.rows - lines.length + 1
    expect(unclampedPanelTop).toBeLessThanOrEqual(0)

    const { region, io } = makeRegion(cols, rowsRef)
    region.render(lines)
    const out = io.all()

    // Clamp: N = min(lines.length, rows - RESERVED_LOG_ROWS) = rows - RESERVED.
    const maxPanel = rowsRef.rows - RESERVED_LOG_ROWS
    expect(maxPanel).toBe(5)
    // Region height == clamp value: one clear-line per panel row (fresh render).
    expect(countOf(out, "\x1b[2K")).toBe(maxPanel)

    // Clamped panel fits: bottom = rows - N ≥ 1, panelTop = rows - N + 1 ≥ 1.
    const bottom = rowsRef.rows - maxPanel
    expect(bottom).toBeGreaterThanOrEqual(1)
    expect(out).toContain(`\x1b[1;${bottom}r`) // DECSTBM bottom = 1
    const panelTop = rowsRef.rows - maxPanel + 1
    expect(panelTop).toBeGreaterThanOrEqual(1)
    expect(out).toContain(`\x1b[${panelTop};1H`) // highest panel row is on-screen

    // Overflow indicator on the last panel row: K = lines.length - (N - 1).
    const hidden = lines.length - (maxPanel - 1)
    expect(hidden).toBe(6)
    expect(out).toContain(`+${hidden} more below`)
    // The last content line before the indicator is shown; deeper lines hidden.
    expect(out).toContain("line3") // last visible content row (index N-2 = 3)
    expect(out).not.toContain("line4") // rows N-1.. folded into the indicator
    expect(out).not.toContain("line9")
  })

  test("clear() resets DECSTBM, erases the panel, reparks the cursor, shows it", () => {
    const { region, io } = makeRegion(80, rowsRef)
    region.render(["a", "b"]) // panelHeight 2, panel at rows 23..24 (rowsRef 24)
    const mark = io.chunks.length
    region.clear()
    const out = io.chunks.slice(mark).join("")

    expect(out).toContain("\x1b[r") // reset scroll region to full screen
    expect(out).toContain("\x1b[23;1H") // move to the panel's top row (just below the last log)
    expect(out).toContain("\x1b[0J") // erase from there to end of screen (wipes the panel)
    expect(out).toContain("\x1b[?25h") // show cursor
    // Order: reset → reposition → erase → show, so nothing is left mid-screen.
    expect(out.indexOf("\x1b[r")).toBeLessThan(out.indexOf("\x1b[23;1H"))
    expect(out.indexOf("\x1b[23;1H")).toBeLessThan(out.indexOf("\x1b[0J"))
  })

  test("clear() resets internal state: next render re-establishes DECSTBM", () => {
    const { region, io } = makeRegion(80, rowsRef)
    region.render(["a", "b"])
    region.clear()
    const mark = io.chunks.length
    region.render(["a", "b"]) // must re-issue DECSTBM after a clear
    const out = io.chunks.slice(mark).join("")
    expect(out).toContain("\x1b[1;22r")
  })

  test("clear() is idempotent: a repeat clear emits no second RESET (established guard)", () => {
    const { region, io } = makeRegion(80, rowsRef)
    region.render(["a", "b"]) // establish
    region.clear() // first collapse: emits exactly one reset
    const mark = io.chunks.length
    region.clear() // repeat: no-op, region already torn down
    const out = io.chunks.slice(mark).join("")
    expect(out).toBe("") // nothing re-emitted
    expect(countOf(io.all(), "\x1b[r")).toBe(1) // exactly one RESET across both clears
  })

  test("clear() before any render is a no-op (no RESET on an unestablished region)", () => {
    const { region, io } = makeRegion(80, rowsRef)
    region.clear()
    expect(io.all()).toBe("")
  })

  test("empty lines tears the region down (no sticky panel)", () => {
    const { region, io } = makeRegion(80, rowsRef)
    region.render(["a", "b"])
    const mark = io.chunks.length
    region.render([])
    const out = io.chunks.slice(mark).join("")
    expect(out).toContain("\x1b[r") // scroll region reset
    // eslint-disable-next-line no-control-regex -- intentional ESC in DECSTBM pattern
    expect(out).not.toMatch(/\x1b\[1;\d+r/) // no new DECSTBM
  })

  describe("isEstablished / clearPanelString / redrawString (P2.2 emergencyWrite hooks)", () => {
    test("isEstablished() is false before any render, true after, false again after clear()", () => {
      const { region } = makeRegion(80, rowsRef)
      expect(region.isEstablished()).toBe(false)
      region.render(["a", "b"])
      expect(region.isEstablished()).toBe(true)
      region.clear()
      expect(region.isEstablished()).toBe(false)
    })

    test("clearPanelString() is '' when unestablished (nothing to clear, no write)", () => {
      const { region } = makeRegion(80, rowsRef)
      expect(region.clearPanelString()).toBe("")
    })

    test("clearPanelString() blanks every panel row and parks the cursor at the scroll-region bottom, without writing", () => {
      const { region, io } = makeRegion(80, rowsRef)
      region.render(["a", "b"]) // rows=24, N=2 → panel rows 23,24; bottom=22
      const mark = io.chunks.length

      const s = region.clearPanelString()
      expect(io.chunks.length).toBe(mark) // pure — no write happened

      expect(s).toContain("\x1b[23;1H")
      expect(s).toContain("\x1b[24;1H")
      expect(countOf(s, "\x1b[2K")).toBe(2) // one clear per panel row
      expect(s.endsWith("\x1b[22;1H")).toBe(true) // parked at scroll-region bottom row, ready for a log write
    })

    test("redrawString() is '' when unestablished", () => {
      const { region } = makeRegion(80, rowsRef)
      expect(region.redrawString(["x"])).toBe("")
    })

    test("redrawString() reasserts DECSTBM and repaints the given lines, without writing", () => {
      const { region, io } = makeRegion(80, rowsRef)
      region.render(["a", "b"]) // establishes rows=24, N=2 → bottom=22
      const mark = io.chunks.length

      const s = region.redrawString(["c", "d"])
      expect(io.chunks.length).toBe(mark) // pure — no write happened

      expect(s).toContain("\x1b[1;22r") // DECSTBM reassert at the established bottom
      expect(s).toContain("\x1b7") // DECSC
      expect(s).toContain("\x1b8") // DECRC
      expect(s).toContain("c")
      expect(s).toContain("d")
      expect(s.endsWith("\x1b8")).toBe(true)
    })

    test("clearPanel then redrawString compose exactly like a normal steady-state re-render", () => {
      // Emergency-write shape (spec §4 "region" state): clearPanel + line + redrawPanel.
      // This test pins that composing the two P2.2 primitives around an out-of-band
      // line reproduces content indistinguishable from a normal re-render.
      const { region, io } = makeRegion(80, rowsRef)
      region.render(["a", "b"])
      const mark = io.chunks.length

      const emergency = region.clearPanelString() + "EMERGENCY LINE\n" + region.redrawString(["a", "b"])
      expect(io.chunks.length).toBe(mark) // still nothing written by the coordinator itself
      expect(emergency).toContain("EMERGENCY LINE")
      expect(emergency).toContain("a")
      expect(emergency).toContain("b")
    })
  })
})
