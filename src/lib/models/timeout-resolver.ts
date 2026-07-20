// Per-model stream-idle / response-header timeout resolution.
//
// Both knobs are scalar-by-default with an optional per-model override map
// (`state.streamIdleTimeoutOverrides` / `state.responseHeaderTimeoutOverrides`,
// keyed by model-name substring, `"*"` wildcard — the same `findMostSpecific`
// pattern used by effort/strip config). Motivation: gpt-5.5(effort=high) emits a
// single 266–462s zero-frame silent-reasoning gap before a terminal burst, which
// the 300s scalar app-guard would kill as a false idle timeout (empirically
// verified 2026-07-12, exp/ws-upstream-keepalive/REPORT.md).
//
// These are APP-GUARD-only knobs — they do NOT touch the undici dispatcher /
// transport backstop. GHC(https) rides node:http2 (`sock.setTimeout(0)`, no
// transport body-idle); undici only serves plaintext SearXNG. See ADR
// 2026-07-12-per-model-idle-timeout-is-app-guard-only.
//
// Resolution: a per-model override (longest-substring match) wins over the
// scalar; `model === undefined` skips the table and returns the scalar; a
// value of 0 means "disabled" (no timeout), preserved through Ms conversion.

import { findMostSpecific } from "~/lib/anthropic/per-model-config"
import { state } from "~/lib/state"

/** Effective stream-idle timeout in seconds for `model` (0 = disabled). */
export function resolveStreamIdleTimeoutSec(model: string | undefined): number {
  if (model !== undefined) {
    const override = findMostSpecific(model, state.streamIdleTimeoutOverrides)
    if (override !== undefined) return override
  }
  return state.streamIdleTimeout
}

/** Effective stream-idle timeout in milliseconds for `model` (0 = disabled/no timeout). */
export function resolveStreamIdleTimeoutMs(model: string | undefined): number {
  const sec = resolveStreamIdleTimeoutSec(model)
  return sec > 0 ? sec * 1000 : 0
}

/** Effective response-header (first-byte) timeout in seconds for `model` (0 = disabled). */
export function resolveResponseHeaderTimeoutSec(model: string | undefined): number {
  if (model !== undefined) {
    const override = findMostSpecific(model, state.responseHeaderTimeoutOverrides)
    if (override !== undefined) return override
  }
  return state.responseHeaderTimeout
}

/** Effective response-header timeout in milliseconds for `model` (0 = disabled/no timeout). */
export function resolveResponseHeaderTimeoutMs(model: string | undefined): number {
  const sec = resolveResponseHeaderTimeoutSec(model)
  return sec > 0 ? sec * 1000 : 0
}
