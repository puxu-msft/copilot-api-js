/**
 * v4 driver migration feature flags (P2 — per-format route switch).
 *
 * Each format's route checks `isV4DriverEnabled(format)` and dispatches to the
 * driver path or the legacy handler. The flag lets a format be switched back to
 * the legacy path at runtime; the old handler is removed only in P3.
 *
 * Module-level mutable: tests that exercise the v4 path enable it and MUST reset
 * it (`setV4DriverEnabled(format, false)`) in an afterEach to avoid cross-file
 * leakage (bun runs the suite in one process). Default is OFF for every format
 * until that format's equivalence is verified.
 */

export type V4DriverFormat = "openai-cc"

const flags: Record<V4DriverFormat, boolean> = {
  "openai-cc": false,
}

export function isV4DriverEnabled(format: V4DriverFormat): boolean {
  return flags[format]
}

export function setV4DriverEnabled(format: V4DriverFormat, enabled: boolean): void {
  flags[format] = enabled
}
