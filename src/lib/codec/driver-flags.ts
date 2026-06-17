/**
 * v4 driver migration feature flags (P2 — per-format route switch).
 *
 * Each format's route checks `isV4DriverEnabled(format)` and dispatches to the
 * driver path or the legacy handler. The flag lets a format be switched back to
 * the legacy path at runtime; the old handler is removed only in P3.
 *
 * Module-level mutable: tests that exercise a specific path enable/restore it and
 * MUST restore the flag's prior value (NOT hardcode false) in an afterEach to
 * avoid cross-file leakage (bun runs the suite in one process).
 *
 * `openai-cc` is ON (P2.3-ON): CC serves through the v4 driver; the legacy
 * `handleChatCompletion` stays in the tree (toggle back here) until P3.3 deletes
 * it. The whole existing CC suite runs through the driver at this default.
 */

export type V4DriverFormat = "openai-cc"

const flags: Record<V4DriverFormat, boolean> = {
  "openai-cc": true,
}

export function isV4DriverEnabled(format: V4DriverFormat): boolean {
  return flags[format]
}

export function setV4DriverEnabled(format: V4DriverFormat, enabled: boolean): void {
  flags[format] = enabled
}
