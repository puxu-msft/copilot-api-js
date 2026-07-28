/**
 * Per-model (per-vendor) override resolution: merge a vendor's overrides over the shared defaults
 * and hand back one resolved config object.
 *
 * These are pure READS — they compute a value from two `state` fields and write nothing. They lived
 * in `state.ts`, which is being reduced to a leaf that depends on nothing but language builtins
 * (docs/plan/2026-07-28-state-to-foundation/HANDOVER.md); resolution is config semantics, not state
 * storage, so it belongs to the config layer.
 *
 * **The location is constrained, not a matter of taste.** Most callers live under `src/routes/**`
 * (the future server package), but `src/lib/config/config.ts` (core) consumes `resolveBufferedCaps`
 * too. Putting this file under `src/routes/` would create a `core → server` edge, and spec
 * §7.2 phase 1 is specifically about eliminating the last of those. It must stay under `src/lib/`.
 *
 * They read LIVE state on every call rather than taking a snapshot argument, exactly as they did
 * before the move: config is hot-reloadable, and a caller that resolved once at construction would
 * silently keep serving the pre-reload values.
 */

import type {
  //
  BufferedRetryCaps,
  BufferedRetryContinuation,
  EffectiveMaxTokensContinuationConfig,
  MaxTokensContinuationConfig,
} from "~/lib/state"

import { state } from "~/lib/state"

/**
 * Resolve the effective buffered-retry caps for one vendor. Priority (highest
 * first): per-vendor override ({@link State.bufferedRetryOverrides}) > shared
 * caps ({@link State.bufferedRetryShared}) > built-in default. Every consumer of
 * `maxRetries` / `bufferCapBytes` / `heartbeatSec` MUST route through this (no
 * direct scalar-field reads — single resolution point).
 */
export function resolveBufferedCaps(vendor: string): BufferedRetryCaps {
  const o = state.bufferedRetryOverrides[vendor] ?? {}
  const s = state.bufferedRetryShared
  return {
    maxRetries: o.maxRetries ?? s.maxRetries,
    bufferCapBytes: o.bufferCapBytes ?? s.bufferCapBytes,
    heartbeatSec: o.heartbeatSec ?? s.heartbeatSec,
  }
}

/**
 * Resolve continuation-retry settings for `vendor` (per-vendor override > shared > built-in default).
 * Single resolution point — mirrors {@link resolveBufferedCaps}.
 */
export function resolveContinuation(vendor: string): BufferedRetryContinuation {
  const o = state.bufferedRetryContinuationOverrides[vendor] ?? {}
  const s = state.bufferedRetryContinuationShared
  return {
    enabled: o.enabled ?? s.enabled,
    message: o.message ?? s.message,
  }
}

/** Resolve max_tokens continuation settings with per-vendor values taking precedence over shared values. */
export function resolveMaxTokensContinuation(vendor: string): MaxTokensContinuationConfig {
  const override = state.maxTokensContinuationOverrides[vendor] ?? {}
  const shared = state.maxTokensContinuationShared
  return {
    enabled: override.enabled ?? shared.enabled,
    maxRounds: override.maxRounds ?? shared.maxRounds,
    classes: {
      text: override.classes?.text ?? shared.classes.text,
      toolUse: override.classes?.toolUse ?? shared.classes.toolUse,
      thinking: override.classes?.thinking ?? shared.classes.thinking,
    },
    message: override.message ?? shared.message,
    visibility: override.visibility ?? shared.visibility,
    thinkingRetryBudget: override.thinkingRetryBudget ?? shared.thinkingRetryBudget,
  }
}

/**
 * Enforce the wire-level constraint that passthrough terminates the stream and therefore cannot stitch.
 * P1 must consume this resolved form before it ever enables continuation behavior.
 */
export function resolveEffectiveMaxTokensContinuation(vendor: string): EffectiveMaxTokensContinuationConfig {
  const config = resolveMaxTokensContinuation(vendor)
  if (config.visibility !== "passthrough") return { ...config, diagnostics: [] }

  const prevented = config.classes.text === "continue" || config.classes.toolUse === "continue" || config.classes.thinking === "retry_with_budget"
  if (!prevented) return { ...config, diagnostics: [] }
  return {
    ...config,
    classes: { text: "passthrough", toolUse: "passthrough", thinking: "passthrough" },
    diagnostics: ["strategy-prevented-stitch"],
  }
}
