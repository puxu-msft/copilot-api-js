/**
 * FORCE_COLOR integration proof for the severity-colored log line.
 *
 * bun's in-process test env has `pc.isColorSupported === false`, which collapses
 * every picocolors wrapper to the identity function — so an in-process assertion
 * can prove color-band ROUTING (via color-fn reference equality, see
 * format.unit.test.ts) but NOT that a band actually emits bold-red / dim-yellow
 * ANSI. This test closes that gap: it renders `formatLogLine` in a child `bun`
 * process with `FORCE_COLOR=3` and asserts the exact SGR sequences for each
 * cache-hit and duration severity band. Guards against a regression where a band
 * routes to the wrong (or identity) color.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

/**
 * Render a set of log lines in a forced-color child process. The script imports
 * the real formatLogLine from source (cwd = project root under bun test) and
 * prints one labeled line per case; we return the raw stdout (ANSI intact).
 */
function renderUnderForcedColor(): string {
  const script = `
    import { formatLogLine } from "./src/lib/observability/projections/log-line.ts"
    const base = { prefix: "[ OK ]", time: "12:34:56", method: "POST", path: "/p", model: "m", status: 200, outputTokens: 1 }
    const cache = (i, r) => ({ ...base, inputTokens: i, cacheReadInputTokens: r, cacheCreationInputTokens: 0 })
    const dur = (ms) => ({ ...base, duration: String(ms/1000)+"s", durationMs: ms })
    const out = {
      cacheDim:      formatLogLine(cache(2000, 8000)),  // 80% -> dim
      cacheYellow:   formatLogLine(cache(2100, 7900)),  // 79% -> yellow
      cacheRed:      formatLogLine(cache(6100, 3900)),  // 39% -> red
      cacheBoldRed:  formatLogLine(cache(8100, 1900)),  // 19% -> bold red
      durWhite:      formatLogLine(dur(3000)),          // 3s   -> white
      durDimYellow:  formatLogLine(dur(45000)),         // 45s  -> dim yellow
      durYellow:     formatLogLine(dur(120000)),        // 120s -> yellow
      durRed:        formatLogLine(dur(200000)),        // 200s -> red
    }
    process.stdout.write(JSON.stringify(out))
  `
  const proc = Bun.spawnSync(["bun", "-e", script], {
    env: { ...process.env, FORCE_COLOR: "3" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = proc.stdout.toString()
  if (!stdout) throw new Error(`child produced no output; stderr:\n${proc.stderr.toString()}`)
  return stdout
}

// SGR building blocks (picocolors basic-mode codes).
const RESET_FG = "\x1b[39m"
const DIM = "\x1b[2m"
const DIM_OFF = "\x1b[22m"
const BOLD = "\x1b[1m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"

describe("formatLogLine severity coloring (FORCE_COLOR integration)", () => {
  const out: Record<string, string> = JSON.parse(renderUnderForcedColor())

  test("cache-hit bands emit distinct ANSI: dim / yellow / red / bold-red", () => {
    // The ↻ marker is present with the band-specific opening SGR. Distinct
    // openers prove the bands are not collapsed to one color.
    expect(out.cacheDim).toContain(`${DIM}↻80%`)
    expect(out.cacheYellow).toContain(`${YELLOW}↻79%${RESET_FG}`)
    expect(out.cacheRed).toContain(`${RED}↻39%${RESET_FG}`)
    expect(out.cacheBoldRed).toContain(`${BOLD}${RED}↻19%`)
    // The severe band is specifically BOLD red, not plain red.
    expect(out.cacheBoldRed).not.toContain(`${RED}↻19%${RESET_FG}${BOLD}`)
    expect(out.cacheDim).not.toContain(`${RED}↻80%`)
  })

  test("duration bands emit distinct ANSI: white / dim-yellow / yellow / red", () => {
    expect(out.durWhite).toContain(`\x1b[37m3s${RESET_FG}`)
    expect(out.durDimYellow).toContain(`${DIM}${YELLOW}45s${RESET_FG}${DIM_OFF}`)
    expect(out.durYellow).toContain(`${YELLOW}120s${RESET_FG}`)
    expect(out.durRed).toContain(`${RED}200s${RESET_FG}`)
    // A fast request must NOT be red; a slow one must NOT be white.
    expect(out.durWhite).not.toContain(`${RED}3s`)
    expect(out.durRed).not.toContain(`\x1b[37m200s`)
  })
})
