/**
 * FORCE_COLOR integration proof for the severity-colored log line.
 *
 * This is the AUTHORITATIVE per-band color test. bun's in-process test env has
 * `pc.isColorSupported === false`, under which picocolors collapses EVERY color
 * to the SAME identity reference: `pc.white === pc.yellow === pc.red === pc.dim
 * === String` (verified). So in-process a single-color band's `.toBe(pc.white)`
 * is really `.toBe(String)` — it cannot distinguish bands and cannot catch an
 * "always red" mutation. The only in-process signal is that a COMPOSITE band
 * (the bold-red shared by cacheHitColor's <20% and durationColor's >180s) is a
 * fresh closure `!== String` (see the `.not.toBe` tests in format.unit.test.ts).
 * Every band's ACTUAL color — all single-color bands and all threshold
 * boundaries — is proven here, by rendering real `formatLogLine` in a
 * `FORCE_COLOR=3` child process and asserting exact SGR bytes. Boundary cases
 * (≤ inclusivity) guard against off-by-one mutations.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { sessionAnsi256 } from "~/lib/observability/projections/session-block"

// SGR building blocks (picocolors basic-mode codes; code 22 resets bold AND dim).
const RESET_FG = "\x1b[39m"
const OFF = "\x1b[22m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const WHITE = "\x1b[37m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"

// The exact bytes picocolors emits for each severity band (probed under FORCE_COLOR).
// Both scales share the yellow → red → bold-red escalation; they differ only at
// the calmest band (cache: dim; duration: white).
const band = {
  dim: (s: string) => `${DIM}${s}${OFF}`,
  white: (s: string) => `${WHITE}${s}${RESET_FG}`,
  yellow: (s: string) => `${YELLOW}${s}${RESET_FG}`,
  red: (s: string) => `${RED}${s}${RESET_FG}`,
  cyan: (s: string) => `${CYAN}${s}${RESET_FG}`,
  green: (s: string) => `${GREEN}${s}${RESET_FG}`,
  boldRed: (s: string) => `${BOLD}${RED}${s}${RESET_FG}${OFF}`,
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
  { label: "20.001s → yellow", ms: 20_001, expect: band.yellow("20.001s") },
  { label: "60s → yellow (≤60 boundary)", ms: 60_000, expect: band.yellow("60s") },
  { label: "60.001s → red", ms: 60_001, expect: band.red("60.001s") },
  { label: "180s → red (≤180 boundary)", ms: 180_000, expect: band.red("180s") },
  { label: "180.001s → bold red", ms: 180_001, expect: band.boldRed("180.001s") },
  { label: "200s → bold red", ms: 200_000, expect: band.boldRed("200s") },
]

/**
 * stop_reason cases: reason → expected category-colored `<reason>` token.
 * The whole token (marker + word + optional tool suffix) carries the category
 * color. Covers one value per band, an unknown value that falls back to dim
 * (still shown raw), a tool_use case with its invoked tool names (white), and an
 * agentic case whose tools include AskUserQuestion (cyan, the interactive-pause
 * highlight).
 */
const stopReasonCases: Array<{ label: string; reason: string; toolNames?: Array<string>; expect: string }> = [
  { label: "end_turn → green (normal completion)", reason: "end_turn", expect: band.green("end_turn") },
  { label: "stop → green (openai normal)", reason: "stop", expect: band.green("stop") },
  { label: "tool_use → white (agentic)", reason: "tool_use", expect: band.white("tool_use") },
  { label: "tool_use with names → white token incl (Bash,Edit)", reason: "tool_use", toolNames: ["Bash", "Edit"], expect: band.white("tool_use(Bash,Edit)") },
  {
    label: "tool_use with AskUserQuestion → cyan (interactive pause)",
    reason: "tool_use",
    toolNames: ["AskUserQuestion"],
    expect: band.cyan("tool_use(AskUserQuestion)"),
  },
  { label: "tool_calls → white (openai agentic)", reason: "tool_calls", expect: band.white("tool_calls") },
  { label: "max_tokens → yellow (truncation)", reason: "max_tokens", expect: band.yellow("max_tokens") },
  { label: "length → yellow (openai truncation)", reason: "length", expect: band.yellow("length") },
  { label: "refusal → red (problematic)", reason: "refusal", expect: band.red("refusal") },
  { label: "content_filter → red (openai problematic)", reason: "content_filter", expect: band.red("content_filter") },
  { label: "surprise → dim (unknown fallback, shown raw)", reason: "surprise", expect: band.dim("surprise") },
]

/**
 * session-identity block cases: the `sessionId`-hashed 256-color glyph (`■` main /
 * `❶❷…` subagent). Expected bytes computed via the real `sessionAnsi256` so the
 * test tracks the palette; a plain `■`/`❶` fallback would prove nothing. Same
 * session ⇒ same color code for main and subagent (only the glyph differs).
 */
const SESS = "sess-alpha"
const blockCode = sessionAnsi256(SESS)
const block256 = (code: number, glyph: string): string => `\x1b[38;5;${code}m${glyph}\x1b[39m`
const blockCases: Array<{ label: string; sessionId?: string; agentId?: string; agentOrdinal?: number; expect: string }> = [
  { label: "main agent → colored solid square", sessionId: SESS, expect: block256(blockCode, "■") },
  { label: "subagent ❶ → same session color, circled 1", sessionId: SESS, agentId: "ag1", agentOrdinal: 1, expect: block256(blockCode, "❶") },
  { label: "subagent ❷ → same session color, circled 2", sessionId: SESS, agentId: "ag2", agentOrdinal: 2, expect: block256(blockCode, "❷") },
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
    const stopReasonCases = ${JSON.stringify(stopReasonCases.map((c) => ({ label: c.label, reason: c.reason, toolNames: c.toolNames })))}
    for (const c of stopReasonCases) out[c.label] = formatLogLine({ ...base, stopReason: c.reason, toolNames: c.toolNames })
    const blockCases = ${JSON.stringify(blockCases.map((c) => ({ label: c.label, sessionId: c.sessionId, agentId: c.agentId, agentOrdinal: c.agentOrdinal })))}
    for (const c of blockCases) out[c.label] = formatLogLine({ ...base, sessionId: c.sessionId, agentId: c.agentId, agentOrdinal: c.agentOrdinal })
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

  for (const c of stopReasonCases) {
    test(`stop_reason ${c.label}`, () => {
      expect(out[c.label]).toContain(c.expect)
    })
  }

  for (const c of blockCases) {
    test(`session-block ${c.label}`, () => {
      expect(out[c.label]).toContain(c.expect)
    })
  }

  test("main and subagent of one session share the exact color code (only the glyph differs)", () => {
    expect(out["main agent → colored solid square"]).toContain(block256(blockCode, "■"))
    expect(out["subagent ❶ → same session color, circled 1"]).toContain(block256(blockCode, "❶"))
  })

  test("bands are mutually distinct (a fast/high-hit case is never colored like a severe one)", () => {
    // Cross-checks: the healthy cache marker is not red; the fast duration is not
    // red. (That the <20 band is specifically BOLD red — not plain red — is
    // already pinned by the positive `band.boldRed("↻19%")` case above: a plain-red
    // regression drops the leading \e[1m and fails that toContain.)
    expect(out["hit 80% → dim (≥80 boundary)"]).not.toContain(RED + "↻80%")
    expect(out["3s → white"]).not.toContain(RED + "3s")
    // A normal end_turn is green, never colored like the agentic (white) or
    // problematic (red) bands — guards against an "always white/red" mutation.
    expect(out["end_turn → green (normal completion)"]).not.toContain(WHITE + "end_turn")
    expect(out["end_turn → green (normal completion)"]).not.toContain(RED + "end_turn")
    // A plain tool_use is white, not the AskUserQuestion cyan highlight — guards
    // against the AskUserQuestion detection collapsing to "always cyan".
    expect(out["tool_use → white (agentic)"]).not.toContain(CYAN + "tool_use")
  })
})
