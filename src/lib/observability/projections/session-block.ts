/**
 * Session identity block: a colored glyph rendered on request log lines to group
 * requests by conversation session and distinguish the main agent from subagents.
 *
 * - color — a stable FNV-1a hash of `sessionId` into the `terminal-neon` palette
 *   (the same hash + palette the History Web UI uses in
 *   `ui-v4/src/lib/session-color.ts`), so a session shows the same hue across the
 *   TUI and the web UI. Palette hexes are converted to their nearest ANSI-256
 *   code once at module load (`\x1b[38;5;Nm`). Requests with the SAME `sessionId`
 *   (a main agent and every subagent it spawns) share one foreground color.
 * - glyph — `■` (solid square) for the main agent (`agentId` absent); a filled
 *   circled number `❶❷…⓴` for subagents, numbered by first-seen order WITHIN the
 *   session (the ordinal is supplied by the caller, see AgentOrdinalRegistry in
 *   `~/lib/tui/agent-ordinal-registry.ts`); `(N)` past 20.
 *
 * A request with no `sessionId` (a non-Claude-Code client, or a missing
 * `x-claude-code-session-id` header) renders NO block — there is nothing to group
 * or color.
 *
 * Pure: no I/O, no mutable state. Honors `pc.isColorSupported` (plain glyph, no
 * SGR, when color is off — the shape still conveys main vs subagent).
 */

import pc from "picocolors"

/** `terminal-neon` base hexes, copied from ui-v4's default SessionPalette (kept in sync by value). */
const TERMINAL_NEON_HEX = ["#00a39a", "#009fb2", "#009bce", "#2f9af2", "#4a78f9", "#6f48f3", "#953cd1", "#a442a8", "#ab448e"] as const

/** The 6 per-channel levels of the ANSI-256 color cube (indices 16–231). */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const

/** Nearest index into {@link CUBE_LEVELS} for one 0–255 channel value. */
function nearestCubeIndex(v: number): number {
  let best = 0
  let bestDist = Infinity
  for (const [i, level] of CUBE_LEVELS.entries()) {
    const d = Math.abs(level - v)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return best
}

/**
 * Convert an `#rrggbb` hex to the nearest ANSI-256 code, choosing between the
 * 6×6×6 color cube (16–231) and the 24-step grayscale ramp (232–255) by whichever
 * is closer in RGB space. Saturated palette colors resolve to the cube; the
 * grayscale branch is a correctness belt for any near-grey value.
 */
function hexToAnsi256(hex: string): number {
  const h = hex.replace("#", "")
  const r = Number.parseInt(h.slice(0, 2), 16)
  const g = Number.parseInt(h.slice(2, 4), 16)
  const b = Number.parseInt(h.slice(4, 6), 16)

  const ri = nearestCubeIndex(r)
  const gi = nearestCubeIndex(g)
  const bi = nearestCubeIndex(b)
  const cubeCode = 16 + 36 * ri + 6 * gi + bi
  const cubeDist = (CUBE_LEVELS[ri] - r) ** 2 + (CUBE_LEVELS[gi] - g) ** 2 + (CUBE_LEVELS[bi] - b) ** 2

  // Grayscale ramp: 232 + n maps to level 8 + 10n (n = 0..23).
  const gray = Math.round((r + g + b) / 3)
  const grayN = Math.min(23, Math.max(0, Math.round((gray - 8) / 10)))
  const grayLevel = 8 + 10 * grayN
  const grayCode = 232 + grayN
  const grayDist = (grayLevel - r) ** 2 + (grayLevel - g) ** 2 + (grayLevel - b) ** 2

  return grayDist < cubeDist ? grayCode : cubeCode
}

/** Precomputed ANSI-256 codes for the terminal-neon palette (parallel to TERMINAL_NEON_HEX). */
const PALETTE_ANSI256: ReadonlyArray<number> = TERMINAL_NEON_HEX.map((hex) => hexToAnsi256(hex))

/** FNV-1a 32-bit — identical to ui-v4's `session-color.ts#hashString` so palette slots line up. */
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.codePointAt(i) ?? 0
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Stable ANSI-256 code for a session (hash(sessionId) → palette slot). */
export function sessionAnsi256(sessionId: string): number {
  return PALETTE_ANSI256[hashString(sessionId) % PALETTE_ANSI256.length]
}

/** Solid square for the main agent. */
const MAIN_GLYPH = "■"

/**
 * Filled circled number for a subagent's 1-based ordinal:
 *   1–10  → ❶..❿  (U+2776..U+277F)
 *   11–20 → ⓫..⓴  (U+24EB..U+24F4)
 *   >20   → "(N)"  (plain fallback — the negative-circled set stops at 20)
 * A non-positive/absent ordinal degrades to a generic filled circle `●`.
 */
export function agentGlyph(ordinal: number | undefined): string {
  if (ordinal === undefined || ordinal < 1) return "●"
  if (ordinal <= 10) return String.fromCodePoint(0x2775 + ordinal)
  if (ordinal <= 20) return String.fromCodePoint(0x24e0 + ordinal)
  return `(${ordinal})`
}

/**
 * Render the session-identity block for a request: a `sessionAnsi256`-colored
 * glyph (`■` main / `❶❷…` subagent). Returns `""` when `sessionId` is absent
 * (nothing to group). Emits a raw 256-color SGR when `pc.isColorSupported`;
 * otherwise the plain glyph (shape still distinguishes main vs subagent).
 */
export function formatSessionBlock(args: { sessionId?: string; agentId?: string; agentOrdinal?: number }): string {
  const { sessionId, agentId, agentOrdinal } = args
  if (!sessionId) return ""
  const glyph = agentId === undefined ? MAIN_GLYPH : agentGlyph(agentOrdinal)
  if (!pc.isColorSupported) return glyph
  return `\x1b[38;5;${sessionAnsi256(sessionId)}m${glyph}\x1b[39m`
}
