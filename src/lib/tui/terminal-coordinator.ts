/**
 * Terminal coordinator — a module-level singleton exposing the single
 * region-aware `emergencyWrite` path for out-of-band writes that absolutely
 * must reach the terminal (a reentrant consola call, a `FileSink` write
 * failure) without corrupting whatever the interactive TUI is currently
 * drawing at the bottom of the screen.
 *
 * Scope (P2.1, spec `docs/spec/2026-07-11-tui-render-model-layered.md` §4/§8):
 * this file only defines the coordinator + the `TerminalHooks` contract.
 * Nothing here yet calls it — P2.2 wires `TerminalUi` as the hooks provider
 * (`registerTerminal` at construction, `unregister()` at `destroy()`) and
 * redirects `republish.ts`'s reentrant stderr fallback and `FileSink`'s write-
 * failure stderr fallback through `emergencyWrite`. Until that lands,
 * `emergencyWrite` is always in the "unregistered" state and behaves exactly
 * like today's direct `process.stderr.write` fallbacks.
 *
 * Purity / layering (ADR `docs/decisions/2026-07-10-tui-terminal-ownership.md`):
 * this module imports nothing from `~/lib/tui/*` or `~/lib/observability/*` —
 * it is a pure leaf. P2.2 will have the *observability* side import this
 * module (the reverse direction), never the other way around, so `tui/`'s
 * existing ESLint sink-import ban stays satisfied. It also never calls
 * `publish`/touches the bus — an emergency write must be safe to call from
 * inside a bus dispatch that is already failing (see `republish.ts`'s H1
 * reentrancy guard), so triggering another publish here would risk the exact
 * log storm that guard exists to prevent.
 *
 * Contract (spec I4): `emergencyWrite` must never be swallowed by
 * `TerminalUi`'s `rendering` reentrancy guard (`renderRegion`'s early
 * `if (this.rendering) return`) — that guard exists to prevent a redraw from
 * recursing into itself, not to gate emergency lines. Because this module has
 * no knowledge of that guard at all (it only calls the `write` hook it was
 * given), an emergency write can never be silently dropped by it — the two
 * concerns are structurally decoupled rather than merely coincidentally
 * compatible.
 */

/** The bottom-of-screen render state `emergencyWrite` branches on, queried fresh on every call. */
export type TerminalRegionState = "region" | "alt" | "inline" | "none"

/**
 * Hooks a registered terminal owner (`TerminalUi`, P2.2) supplies. `state`,
 * `clearPanel`, and `redrawPanel` are pure — they only report/produce escape
 * sequences, never write. `write` is the single side-effecting sink; the
 * coordinator never touches `process.stdout` itself once a terminal is
 * registered, so all output funnels through the same place the terminal
 * already uses for its own rendering.
 */
export interface TerminalHooks {
  /** Current bottom-of-screen render state: which of the three live view modes (or none) is active right now. */
  state: () => TerminalRegionState
  /** Escape sequence(s) that clear whatever panel/footer is currently drawn at the bottom of the screen. */
  clearPanel: () => string
  /** Escape sequence(s) that repaint the panel/footer after an emergency line has been written above it. */
  redrawPanel: () => string
  /** The write sink — e.g. `process.stdout.write`. */
  write: (s: string) => void
}

/**
 * Module-level singleton: `undefined` until a terminal registers itself.
 * There is at most one interactive terminal per process (P0/P1 ADR decision 1
 * — TerminalUi owns the terminal exclusively), so a single slot — not a
 * list — is the right shape.
 */
let registered: TerminalHooks | undefined

/**
 * Register the active terminal's hooks. Returns an `unregister()` that clears
 * the registration — call it at `TerminalUi.destroy()` (P2.2) so a torn-down
 * terminal stops receiving emergency writes, and in tests so module-level
 * state never leaks across cases. `unregister()` is a no-op if a *different*
 * registration has since replaced this one (defends against a stale
 * `unregister` closure firing out of order).
 */
export function registerTerminal(hooks: TerminalHooks): () => void {
  registered = hooks
  return () => {
    if (registered === hooks) registered = undefined
  }
}

/**
 * Test-only reset for the module-level `registered` singleton (whole-branch
 * review I3, test-isolation). Registered in the `RESETTERS` table
 * (`tests/helpers/isolated-fixture.ts`) so a test that constructs a
 * non-`silent` `TerminalUi` and forgets to call `destroy()` (which normally
 * unregisters via the closure `registerTerminal` returned) can never leak its
 * registration into the next test file — mirrors the fixture's other module-
 * global resets (e.g. `resetUpstreamWsManagerForTests`).
 */
export function resetTerminalCoordinatorForTests(): void {
  registered = undefined
}

/**
 * Emit an emergency line — a message that must reach the terminal without
 * being lost or corrupting in-flight rendering. Branches on the registered
 * terminal's current {@link TerminalRegionState}:
 *
 *  - unregistered → writes straight to `process.stderr` (today's unchanged
 *    fallback behavior, so landing this module alone changes nothing
 *    observable until P2.2 wires a caller);
 *  - `"region"` (DECSTBM panel active) or `"inline"` (P0 non-interactive
 *    footer active) → **one atomic `hooks.write` call**: `clearPanel() + line
 *    + "\n" + redrawPanel()`. Both states share the same clear-write-redraw
 *    shape; only what `clearPanel`/`redrawPanel` produce differs (panel
 *    escape sequences vs. the inline footer's `CLEAR_LINE` + rebuild), and
 *    that distinction lives entirely in the registered hooks, not here;
 *  - `"alt"` (detail alternate-screen active) → write-through:
 *    `hooks.write(line + "\n")` with no clear/redraw. There is no panel to
 *    clear on the alt screen; emergency semantics here is "pollute the detail
 *    view rather than lose the line" (spec I-new-1 — sooner-pollute-than-lose,
 *    not queued/best-effort);
 *  - `"none"` (no bottom-of-screen rendering at all) → the same
 *    write-through as `"alt"` — nothing to clear or redraw.
 */
export function emergencyWrite(line: string): void {
  if (!registered) {
    process.stderr.write(`${line}\n`)
    return
  }
  const hooks = registered
  const state = hooks.state()
  if (state === "region" || state === "inline") {
    hooks.write(`${hooks.clearPanel()}${line}\n${hooks.redrawPanel()}`)
    return
  }
  // "alt" (write-through, spec I-new-1) and "none" (nothing to clear/redraw).
  hooks.write(`${line}\n`)
}
