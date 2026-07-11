/**
 * FORCE_COLOR integration proof for the severity-colored log line.
 *
 * This is the AUTHORITATIVE per-band color test. bun's in-process test env has
 * `pc.isColorSupported === false`, under which picocolors collapses EVERY color
 * to the SAME identity reference: `pc.white === pc.yellow === pc.red === pc.dim
 * === String` (verified). So in-process a single-color band's `.toBe(pc.white)`
 * is really `.toBe(String)` — it cannot distinguish bands and cannot catch an
 * "always red" mutation. The only in-process signal is that the COMPOSITE bands
 * (bold-red / dim-yellow) are fresh closures `!== String` (see the `.not.toBe`
 * tests in format.unit.test.ts). Every band's ACTUAL color — including the three
 * single-color bands and all threshold boundaries — is proven here, by rendering
 * real `formatLogLine` in a `FORCE_COLOR=3` child process and asserting exact SGR
 * bytes. Boundary cases (≥/≤ inclusivity) guard against off-by-one mutations.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

// SGR building blocks (picocolors basic-mode codes; code 22 resets bold AND dim).
const RESET_FG = "\x1b[39m"
const OFF = "\x1b[22m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const WHITE = "\x1b[37m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"

// The exact bytes picocolors emits for each severity band (probed under FORCE_COLOR).
const band = {
  dim: (s: string) => `${DIM}${s}${OFF}`,
  white: (s: string) => `${WHITE}${s}${RESET_FG}`,
  yellow: (s: string) => `${YELLOW}${s}${RESET_FG}`,
  red: (s: string) => `${RED}${s}${RESET_FG}`,
  boldRed: (s: string) => `${BOLD}${RED}${s}${RESET_FG}${OFF}`,
  dimYellow: (s: string) => `${DIM}${YELLOW}${s}${RESET_FG}${OFF}`,
}

/**
 * cache-hit cases: `{ i, r }` (creation=0 → marker is just `↻<pct>%`) mapped to
 * the expected colored marker. Boundaries: 80/40/20 are inclusive lower edges.
 */
const cacheCases: Array<{ label: string; i: number; r: number; expect: string }> = [
  { label: "hit 80% → dim (≥80 boundary)", i: 2000, r: 8000, expect: band.dim("↻80%") },
  { label: "hit 79% → yellow", i: 2100, r: 7900, expect: band.yellow("↻79%") },
  { label: "hit 40% → yellow (≥40 boundary)", i: 6000, r: 4000, expect: band.yellow("↻40%") },
  { label: "hit 39% → red", i: 6100, r: 3900, expect: band.red("↻39%") },
  { label: "hit 20% → red (≥20 boundary)", i: 8000, r: 2000, expect: band.red("↻20%") },
  { label: "hit 19% → bold red", i: 8100, r: 1900, expect: band.boldRed("↻19%") },
]

/** duration cases: ms → expected colored duration string. Boundaries inclusive on the ≤ side. */
const durationCases: Array<{ label: string; ms: number; expect: string }> = [
  { label: "3s → white", ms: 3000, expect: band.white("3s") },
  { label: "20s → white (≤20 boundary)", ms: 20_000, expect: band.white("20s") },
  { label: "20.001s → dim yellow", ms: 20_001, expect: band.dimYellow("20.001s") },
  { label: "60s → dim yellow (≤60 boundary)", ms: 60_000, expect: band.dimYellow("60s") },
  { label: "60.001s → yellow", ms: 60_001, expect: band.yellow("60.001s") },
  { label: "180s → yellow (≤180 boundary)", ms: 180_000, expect: band.yellow("180s") },
  { label: "180.001s → red", ms: 180_001, expect: band.red("180.001s") },
  { label: "200s → red", ms: 200_000, expect: band.red("200s") },
]

/**
 * Render every case in one forced-color child process. The script imports the
 * real formatLogLine from source (cwd = project root under bun test); duration
 * text is `formatDuration(ms)` so the expected strings above must match its
 * output (e.g. 20_001ms → "20.0s"? no — formatDuration gives one-decimal
 * seconds). To avoid coupling to the formatter, the script emits the exact
 * rendered line per case keyed by label; we assert the colored fragment is present.
 */
function renderAllUnderForcedColor(): Record<string, string> {
  const script = `
    import { formatLogLine } from "./src/lib/observability/projections/log-line.ts"
    const base = { prefix: "[ OK ]", time: "12:34:56", method: "POST", path: "/p", model: "m", status: 200, outputTokens: 1 }
    const cacheCases = ${JSON.stringify(cacheCases.map((c) => ({ label: c.label, i: c.i, r: c.r })))}
    const durationCases = ${JSON.stringify(durationCases.map((c) => ({ label: c.label, ms: c.ms })))}
    const out = {}
    for (const c of cacheCases) out[c.label] = formatLogLine({ ...base, inputTokens: c.i, cacheReadInputTokens: c.r, cacheCreationInputTokens: 0 })
    // Duration text is supplied explicitly so the expected fragment is exact
    // (independent of formatDuration's rounding), while durationMs drives the color.
    const durText = { 3000: "3s", 20000: "20s", 20001: "20.001s", 60000: "60s", 60001: "60.001s", 180000: "180s", 180001: "180.001s", 200000: "200s" }
    for (const c of durationCases) out[c.label] = formatLogLine({ ...base, duration: durText[c.ms], durationMs: c.ms })
    process.stdout.write(JSON.stringify(out))
  `
  const proc = Bun.spawnSync(["bun", "-e", script], {
    env: { ...process.env, FORCE_COLOR: "3" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = proc.stdout.toString()
  if (!stdout) throw new Error(`child produced no output; stderr:\n${proc.stderr.toString()}`)
  return JSON.parse(stdout) as Record<string, string>
}

describe("formatLogLine severity coloring (FORCE_COLOR integration — authoritative)", () => {
  const out = renderAllUnderForcedColor()

  for (const c of cacheCases) {
    test(`cache-hit ${c.label}`, () => {
      expect(out[c.label]).toContain(c.expect)
    })
  }

  for (const c of durationCases) {
    test(`duration ${c.label}`, () => {
      expect(out[c.label]).toContain(c.expect)
    })
  }

  test("bands are mutually distinct (a fast/high-hit case is never colored like a severe one)", () => {
    // Cross-checks: the healthy cache marker is not red; the fast duration is not
    // red. (That the <20 band is specifically BOLD red — not plain red — is
    // already pinned by the positive `band.boldRed("↻19%")` case above: a plain-red
    // regression drops the leading \e[1m and fails that toContain.)
    expect(out["hit 80% → dim (≥80 boundary)"]).not.toContain(RED + "↻80%")
    expect(out["3s → white"]).not.toContain(RED + "3s")
  })
})
