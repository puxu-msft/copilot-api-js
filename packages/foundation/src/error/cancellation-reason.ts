/**
 * Structured cancellation-cause tags.
 *
 * Sibling of {@link file://./transport-reason.ts}: the layer that CANCELS an
 * in-flight request is the only one that knows why, so it — not the boundary
 * that later has to explain the failure to a client — owns the classification.
 * Every cancellation source tags the `AbortError` it aborts with; the client
 * boundaries (`forwardError` pre-commit, `classifyPostCommitAbort` post-commit)
 * read the tag instead of guessing from signal state or elapsed time.
 *
 * Why this exists: before it, the reaper, the hard request deadline, a candidate
 * dispatch cancellation and an upstream response-header timeout ALL surfaced as
 * the same bare `Error("The operation was aborted.")`, so the pre-commit boundary
 * reported every one of them as "Upstream timed out before sending response
 * headers" — a claim that was demonstrably false (2026-07-28: a 609ms request
 * blamed on a 900s header timeout) and that post-mortems could only unpick by
 * comparing `durationMs` against configured timeouts.
 *
 * The tag is a Symbol-keyed property: no collision, invisible to JSON/logging,
 * and read recursively through `cause` so a wrapping layer cannot lose it.
 */

const CANCELLATION_CAUSE = Symbol("cancellationCause")

/**
 * Who cancelled an in-flight request.
 * - `stale-reaper`: a request-level force-fail through `reapInFlight()` (today: shutdown's
 *   operator-abandoned drain).
 * - `client-request-deadline`: the whole-request hard deadline (`timeouts.client_request_deadline`)
 *   fired. Semantically a TIMEOUT, not a generic cancellation — boundaries map it to 504.
 * - `upstream-request-deadline`: ONE upstream attempt outlived `timeouts.upstream_request_deadline`.
 *   Also a timeout, but attempt-scoped: the retry/hedge budget is untouched, so this only reaches a
 *   client when it was the last attempt available.
 * - `request-cancel`: any other explicit `ctx.cancel(reason)`; the reason text is
 *   the error message.
 * - `dispatch-cancel`: a candidate/dispatch-local teardown (hedge loser, forced
 *   disposal) — internal, never the client's doing.
 */
export type CancellationCause = "stale-reaper" | "client-request-deadline" | "upstream-request-deadline" | "request-cancel" | "dispatch-cancel"

/** The `ctx.cancel()` reason string the whole-request hard deadline uses; mapped to `client-request-deadline`. */
export const CLIENT_REQUEST_DEADLINE_CANCEL_REASON = "client_request_deadline"

/** The dispatch-cancel reason string the per-attempt deadline uses; mapped to `upstream-request-deadline`. */
export const UPSTREAM_REQUEST_DEADLINE_CANCEL_REASON = "upstream_request_deadline"

/** Tag an existing error with a cancellation cause and return it (for inline use at throw sites). */
export function tagCancellationCause<E extends Error>(err: E, cause: CancellationCause): E {
  ;(err as Error & { [CANCELLATION_CAUSE]?: CancellationCause })[CANCELLATION_CAUSE] = cause
  return err
}

/**
 * Build the tagged `AbortError` to pass to `controller.abort(...)`. `message` is
 * operator-facing text that reaches logs, History and (per the internal-tool
 * posture) the client error body verbatim.
 */
export function cancellationAbortError(cause: CancellationCause, message: string): DOMException {
  return tagCancellationCause(new DOMException(message, "AbortError"), cause)
}

/** Read the structured cancellation cause from `err` (or its `cause` chain); `undefined` if untagged. */
export function getCancellationCause(err: unknown): CancellationCause | undefined {
  if (!(err instanceof Error)) return undefined
  const tagged = (err as Error & { [CANCELLATION_CAUSE]?: CancellationCause })[CANCELLATION_CAUSE]
  if (tagged) return tagged
  if (err.cause instanceof Error) return getCancellationCause(err.cause)
  return undefined
}
