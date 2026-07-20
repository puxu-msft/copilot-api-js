/**
 * PoC-2b: sticky bottom region via DECSTBM scroll region (vs the relative-cursor
 * approach in sticky-region.ts). Bench-off: which keeps a bottom N-line panel
 * pinned WITHOUT anchor drift when logs exceed the terminal height and the
 * terminal scrolls natively?
 *
 * DECSTBM (`\x1b[<top>;<bottom>r`) sets a scroll region: logs printed inside the
 * top region scroll only within it; the bottom N lines are a reserved panel that
 * native scroll never disturbs. This is how tmux/htop-style bottom bars survive
 * scrollback, unlike relative-cursor (`\x1b[NF`) which mis-anchors once the
 * bottom write triggers a full-screen scroll.
 *
 * Run in a REAL terminal: `bun exp/tui-rawmode/sticky-region-decstbm.ts`
 * Watch: let logs fill past the screen height so the terminal scrolls. The
 * 3-line panel must stay pinned + intact (no drift, no duplication). Resize the
 * window: the region must re-establish at the new bottom. Ctrl-C/'q' to quit —
 * MUST reset the scroll region (`\x1b[r`) or your terminal stays broken.
 *
 * Compare against sticky-region.ts under the SAME abuse (overflow + resize +
 * native scroll) and record which survives, in the README.
 */

import stringWidth from "string-width"

const stdin = process.stdin
const stdout = process.stdout
const PANEL_H = 3

if (typeof stdin.setRawMode !== "function") {
  console.error("Not a TTY. Run in a real terminal.")
  process.exit(1)
}

const cols = (): number => stdout.columns ?? 80
const rows = (): number => stdout.rows ?? 24

function truncate(s: string, max: number): string {
  if (max <= 0) return ""
  if (stringWidth(s) <= max) return s
  let w = 0
  let out = ""
  for (const ch of s) {
    const cw = stringWidth(ch)
    if (w + cw > max - 1) break
    w += cw
    out += ch
  }
  return out + "…"
}

/** Establish scroll region = rows above the panel; park panel at the bottom. */
function setupScrollRegion(): void {
  const r = rows()
  const top = 1
  const bottom = r - PANEL_H
  stdout.write("\x1b[2J") // clear
  stdout.write(`\x1b[${top};${bottom}r`) // DECSTBM: scroll region = top..bottom
  stdout.write(`\x1b[${bottom};1H`) // move into scroll region
}

function drawPanel(): void {
  const r = rows()
  const w = cols()
  const panelTop = r - PANEL_H + 1
  stdout.write("\x1b7") // save cursor (DECSC)
  for (let i = 0; i < PANEL_H; i++) {
    stdout.write(`\x1b[${panelTop + i};1H`) // move to panel line
    stdout.write("\x1b[2K") // clear line
  }
  stdout.write(`\x1b[${panelTop};1H`)
  const line =
    truncate("─".repeat(Math.min(w, 40)), w - 1) +
    "\n" +
    truncate(`DECSTBM panel  w=${w} h=${r}  logs=${logN}`, w - 1) +
    "\n" +
    truncate("long: " + "y".repeat(300), w - 1)
  stdout.write(line)
  stdout.write("\x1b8") // restore cursor (DECRC) — back into scroll region
}

function restore(): void {
  stdout.write("\x1b[r") // reset scroll region to full screen
  stdout.write("\x1b[?25h")
  stdin.setRawMode(false)
  stdin.pause()
  const r = rows()
  stdout.write(`\x1b[${r};1H\n`)
}

let logN = 0
setupScrollRegion()
drawPanel()

const timer = setInterval(() => {
  logN++
  // Print a log line INSIDE the scroll region (cursor is parked there).
  stdout.write(`[log ${logN}] ${new Date().toISOString()} lifecycle line\n`)
  drawPanel()
}, 250)

stdin.setRawMode(true)
stdin.resume()
stdin.on("data", (buf: Buffer) => {
  if (buf.includes(0x03) || (buf.length === 1 && buf[0] === 0x71)) {
    clearInterval(timer)
    restore()
    console.log("done (scroll region reset)")
    process.exit(0)
  }
})

stdout.on("resize", () => {
  setupScrollRegion()
  drawPanel()
})
