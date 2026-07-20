/**
 * PoC-2: sticky bottom region — a fixed N-line panel pinned to the bottom while
 * "log" lines scroll above it. Tests cursor management, width/height clamping,
 * and resize handling in Bun.
 *
 * Run in a REAL terminal: `bun exp/tui-rawmode/sticky-region.ts`
 * Watch: logs scroll above; the 3-line region stays pinned to the bottom; the
 * long line is truncated to the current width; resize the window and confirm it
 * re-clamps without garbling. Ctrl-C or 'q' to quit (terminal must restore).
 */

import stringWidth from "string-width"

const stdin = process.stdin
const stdout = process.stdout
const REGION_HEIGHT = 3

if (typeof stdin.setRawMode !== "function") {
  console.error("Not a TTY. Run in a real terminal.")
  process.exit(1)
}

function cols(): number {
  return stdout.columns ?? 80
}

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

let logN = 0

/** Clear the region (cursor is assumed to be at region top), print log, redraw region. */
function printLogLine(text: string): void {
  // Move to region top, clear to end of screen, print log + region.
  stdout.write("\x1b[s") // save cursor (unused fallback)
  // Erase the region: move up REGION_HEIGHT lines from current, clear down.
  stdout.write(`\x1b[${REGION_HEIGHT}F`) // cursor to start of line REGION_HEIGHT up
  stdout.write("\x1b[0J") // clear from cursor to end of screen
  stdout.write(text + "\n")
  drawRegion()
}

function drawRegion(): void {
  const w = cols()
  const rows = stdout.rows ?? 24
  const bar = "─".repeat(Math.max(0, Math.min(w, 40)))
  const longLine = truncate(`region row: ` + "x".repeat(300), w - 1)
  const lines = [
    truncate(bar, w - 1),
    truncate(`w=${w} h=${rows}  t=${new Date().toISOString().slice(11, 19)}  logs=${logN}`, w - 1),
    longLine,
  ]
  stdout.write(lines.join("\n"))
}

function restore(): void {
  stdin.setRawMode(false)
  stdin.pause()
  stdout.write("\n")
}

// Reserve the region: print REGION_HEIGHT blank lines then draw.
stdout.write("\n".repeat(REGION_HEIGHT))
stdout.write(`\x1b[${REGION_HEIGHT}F`)
// Prime: move cursor below where logs will go.
stdout.write("\n".repeat(REGION_HEIGHT))
drawRegion()

const timer = setInterval(() => {
  logN++
  printLogLine(`[log ${logN}] ${new Date().toISOString()} some request lifecycle line`)
}, 300)

stdin.setRawMode(true)
stdin.resume()
stdin.on("data", (buf: Buffer) => {
  if (buf.includes(0x03) || (buf.length === 1 && buf[0] === 0x71)) {
    clearInterval(timer)
    restore()
    console.log("done")
    process.exit(0)
  }
})

stdout.on("resize", () => drawRegion())
