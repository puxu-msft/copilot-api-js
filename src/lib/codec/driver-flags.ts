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
 *
 * `openai-responses` starts OFF (P2.4): the v4 Responses path (codec + WS-capable
 * transport + handler-v4 + client-WS-on-driver) is wired but the route defaults to
 * the legacy `handleResponses`/`handleResponseCreate` until the v4↔legacy
 * equivalence tests are in place; flipping it ON (the P2.4 canary) routes the whole
 * existing Responses suite through the driver as a wide oracle.
 *
 * `gemini` is ON (P2.5 canary): the v4 Gemini path (a thin codec that delegates
 * the CC-payload S2–S6 to an internal openai-cc codec + a Gemini parse/render
 * shell) serves through the driver; the legacy `handleGenerateContent` /
 * `handleStreamGenerateContent` stay in the tree (toggle back here) until P3.3
 * deletes them. The whole existing Gemini suite runs through the driver.
 *
 * `anthropic` starts OFF (P2.6 / C3b): the v4 Anthropic /v1/messages path (the
 * heaviest codec + 8 retry strategies + beta-probe + byte-critical streaming
 * pump reused from streaming-pump.ts) is wired but the route defaults to the
 * legacy `handleMessages` until the v4↔legacy equivalence tests are in place;
 * flipping it ON (the P2.6 canary, C4) routes the whole existing Anthropic suite
 * through the driver as a wide oracle.
 */

export type V4DriverFormat = "openai-cc" | "openai-responses" | "gemini" | "anthropic"

const flags: Record<V4DriverFormat, boolean> = {
  "openai-cc": true,
  "openai-responses": true,
  gemini: true,
  anthropic: true,
}

export function isV4DriverEnabled(format: V4DriverFormat): boolean {
  return flags[format]
}

export function setV4DriverEnabled(format: V4DriverFormat, enabled: boolean): void {
  flags[format] = enabled
}
