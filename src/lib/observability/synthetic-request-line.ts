/**
 * Publisher for synthetic request-style log lines (`system.request_line`).
 *
 * Out-of-observability routes (count_tokens — see `observability/middleware.ts`
 * SYNTHETIC_PATHS) create no RequestContext, so they can't render through the
 * normal `request.completed` → TerminalUi path. This lets them emit a
 * request-SHAPED line (same `formatLogLine` projection) that reaches ONLY the
 * display sinks (TerminalUi stdout + FileSink) — never history / telemetry /
 * calibration / WS.
 *
 * Mirrors the `setShutdownPublisher` / `setRateLimitPublisher` DI pattern: the
 * `system`-scoped publisher is injected once at `start.ts`. When unset (tests,
 * pre-init), `publishRequestLine` is a silent no-op.
 */

import type { LogLineParts } from "~/lib/observability/projections/log-line"

import type { ScopedPublisher } from "./bus"

let publisher: ScopedPublisher<"system"> | null = null

/** Inject the system-scoped publisher (called once at start.ts). */
export function setRequestLinePublisher(p: ScopedPublisher<"system">): void {
  publisher = p
}

/** Reset for tests. */
export function resetRequestLinePublisher(): void {
  publisher = null
}

/**
 * Emit a request-shaped line for a synthetic (out-of-observability) route.
 * No-op when no publisher is wired (tests / pre-init).
 */
export function publishRequestLine(parts: LogLineParts): void {
  publisher?.publish({ kind: "system.request_line", parts })
}
