/**
 * Pre-commit error-shaping glue for the Anthropic `/v1/messages` route (Phase 2,
 * docs/plan/2026-07-13-upstream-error-client-shaping/phase-2-precommit-retry-signal.md).
 *
 * `route.ts`'s two `catch (error)` blocks (`/` and `/count_tokens`) are the ONLY pre-commit entry
 * point — `handleMessagesV4`/`handleCountTokens` throw before any bytes are committed, so the HTTP
 * status/headers are still free to shape here. This module is deliberately a `routes/` file (not
 * `lib/`): it composes `lib/error` (`classifyError`/`forwardError`, format-agnostic, shared by 6
 * non-Anthropic routes) with `lib/anthropic/error-shaping` (Phase 1's `decide()`, Anthropic-only) —
 * a combination that must NOT live inside either `lib/` module (see error-shaping.ts's header: it
 * must not depend on `routes/`, and `forward.ts` must stay untouched so the other 6 routes are
 * unaffected, Global Constraint #3). Dependency direction is routes→lib, which is allowed.
 *
 * `forwardError` itself is called UNCHANGED in every branch — only the RESPONSE HEADERS are
 * augmented via Hono's `c.header()` (which must run BEFORE `c.json()` builds the response, same
 * convention as `handler-v4.ts:applyForwardedAnthropicResponseHeaders`). The response BODY is
 * always whatever `forwardError` already produces; this Phase does not touch it.
 *
 * Scope: only the A-class (`retry-signal`) branch is acted on. `ask-user-question` (B-class) and
 * `canonical-error` (C-class, and B-class with the AUQ toggle off) fall through to plain
 * `forwardError` — AUQ body synthesis is Phase 4's job (see `decide()`'s doc comment for the class
 * table). `defer-to-block-level` is a post-commit-only decision kind that `decide()` never returns
 * for a pre-commit input, so it is unreachable here (exhaustive `switch` would need a `never` guard;
 * a `if` chain is enough since the two acted-on/passthrough kinds cover the pre-commit range).
 */
import type { Context } from "hono"

import type { ClientFrame } from "~/lib/pipeline/types"

import {
  //
  buildCanonicalErrorFrame,
  decide,
  type ErrorShapingConfig,
} from "~/lib/anthropic/error-shaping"
import {
  //
  classifyError,
  forwardError,
  isAbortError,
} from "~/lib/error"
import { state } from "~/lib/state"

/** Snapshot the 4 error-shaping config keys off `state` (Phase 0) into the pure `decide()` input. */
export function errorShapingConfigFromState(): ErrorShapingConfig {
  return {
    enabled: state.errorShapingEnabled,
    askUserQuestion: state.errorAskUserQuestion,
    auqTemplate: state.errorAuqTemplate,
    selfhealDelegate: state.errorSelfhealDelegate,
  }
}

/**
 * Pre-commit Anthropic error entry point for `route.ts`.
 *
 * Golden-locked (CF-2): when `error_shaping_enabled` is false, `decide()` is never called at all —
 * this delegates straight to `forwardError`, byte-identical to the pre-error-shaping behaviour.
 * `decide()` itself does NOT read `config.enabled` (Phase 1 leaves that gate to the caller), so this
 * check must happen here, before `decide()` is invoked.
 *
 * Aborts are also routed straight to `forwardError` unchanged: `classifyError` maps them to the
 * `aborted` type, which `decide()` explicitly refuses (throws) as a non-target — aborts are not an
 * upstream failure to shape, they are the existing client-disconnect / header-timeout path.
 *
 * CF-1 (carry-forward from the Phase 1 review): a 401/403 that still has a token-refresh left is
 * consumed transparently by the `token-refresh` `RetryStrategy` several layers below this — the
 * pipeline retries and either succeeds (no error ever reaches here) or fails with a DIFFERENT error.
 * Only an EXHAUSTED 401/403 (`token-refresh`'s `canHandle` returns false because it already spent its
 * one refresh) bubbles out of the pipeline as an `HTTPError` and reaches this function as
 * `auth_expired`. This function does not special-case that — it is a structural property of the
 * pipeline's strategy ordering, verified from the caller's (black-box) side by the `.it` integration
 * test (`error-shaping-precommit.it.test.ts`), not re-implemented here.
 */
export function shapePrecommitError(c: Context, error: unknown): Response {
  if (!state.errorShapingEnabled) return forwardError(c, error)
  if (error instanceof Error && isAbortError(error)) return forwardError(c, error)

  const apiError = classifyError(error)
  if (apiError.type === "aborted") return forwardError(c, error)

  const decision = decide({
    error: apiError,
    commitPhase: "pre-commit",
    clientVisibleStopEmitted: false,
    config: errorShapingConfigFromState(),
  })

  if (decision.kind === "retry-signal") {
    if (decision.retryAfterSec !== undefined) c.header("Retry-After", String(decision.retryAfterSec))
    c.header("x-should-retry", "true")
  }
  // "ask-user-question": Phase 4 TODO — falls through to forwardError unchanged for now.
  // "canonical-error": current forwardError behaviour is already correct, no header changes.
  return forwardError(c, error)
}

/**
 * POST-COMMIT terminal-frame shaping for the handler's `writeSynthetic` termini (Phase 3, G-3
 * canonical ownership). Once the proxy has committed a 200 SSE stream the HTTP status is locked, so an
 * upstream failure can only be delivered as an Anthropic `event:error` FRAME. The two `ApiError`-bearing
 * termini (① HTTPError, ①' unknown-non-HTTP e.g. `network_error`/socket reset) classify their error and
 * delegate the frame construction here, replacing hand-built JSON with the single `error-shaping`
 * builder.
 *
 * Golden lock (CF-2): when `error_shaping_enabled` is false, `decide()` is NEVER called — this returns
 * the caller's `legacyFrame` verbatim (byte-identical to the pre-error-shaping behaviour). When enabled,
 * `decide({commitPhase:"post-commit"})` always resolves to a `canonical-error` kind (post-commit has no
 * retry-signal / AUQ option in the Phase 1 truth table — the status is locked), so
 * `buildCanonicalErrorFrame` produces the frame. The `network_error` post-commit case (terminus ①',
 * which `classifyError` only ever produces from the non-HTTPError branch) is thus routed through
 * `decide()` for the first time — the truth table's `network_error → canonical-error` promise is finally
 * exercised end-to-end.
 *
 * CF-3: the canonical `event:error` frame carries `error.type` = the Anthropic wire literal (e.g. 402 →
 * `rate_limit_error`); with the SSE status locked at 200 (undefined at the client), CC's post-commit
 * retry triggers (status 529 / a `"type":"overloaded_error"` message substring — exp/cc-error-retry-surface/FINDINGS.md)
 * are not hit, so this frame never provokes an unintended client retry.
 */
export function shapePostcommitErrorFrame(error: unknown, legacyFrame: ClientFrame): ClientFrame {
  if (!state.errorShapingEnabled) return legacyFrame
  const decision = decide({
    error: classifyError(error),
    commitPhase: "post-commit",
    clientVisibleStopEmitted: false,
    config: errorShapingConfigFromState(),
  })
  // Post-commit `decide()` is total onto `canonical-error` (no retry-signal / AUQ / defer post-commit).
  // The defensive fallback keeps the legacy frame if a future truth-table change ever yields otherwise.
  if (decision.kind !== "canonical-error") return legacyFrame
  return buildCanonicalErrorFrame(decision)
}

/**
 * POST-COMMIT terminal-frame shaping for the STREAM-lifecycle termini that have NO classifiable
 * `ApiError` object (Phase 3 FIX-2, G-3 canonical ownership completion). These are the pumps' H3
 * (`stream-error` — the upstream iterable/sink threw; the caller pre-classifies via
 * `anthropicStreamErrorType`) and truncation (a clean drain WITHOUT the terminator) branches, on BOTH the
 * direct Anthropic pump AND the reverse translate leg (whose client IS a `/v1/messages` client, so the
 * "Anthropic path only" scope covers it — the excluded formats are OpenAI/Gemini clients on their OWN
 * endpoints, not this leg).
 *
 * Unlike {@link shapePostcommitErrorFrame} there is no `ApiError` to run through `decide()`: the caller
 * already resolved the wire `errorType` + `message`, so this just routes them through the single
 * `buildCanonicalErrorFrame` constructor (G-3) instead of hand-built JSON. The output is BYTE-IDENTICAL to
 * the former hand-built `{type:"error", error:{type, message}}` literal (same field order, no retry_after),
 * so the enabled/disabled split is a formality here — but the CF-2 golden lock is kept for symmetry with
 * ①/①' (and to make "off = the exact legacy bytes" a single, uniform contract across all six termini): the
 * caller passes the legacy frame and gets it back verbatim when `error_shaping_enabled` is false.
 */
export function shapeRawStreamErrorFrame(errorType: string, message: string, legacyFrame: ClientFrame): ClientFrame {
  if (!state.errorShapingEnabled) return legacyFrame
  return buildCanonicalErrorFrame({ kind: "canonical-error", errorType, message })
}
