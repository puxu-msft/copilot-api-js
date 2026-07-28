/**
 * Structured transport-error reason tags.
 *
 * The h2 transport (http2-client.ts) is the layer with the most context about
 * WHY an upstream request failed, so it — not classifyError — owns the semantic
 * classification of transport errors. It tags each error it constructs (or
 * observes from node:http2, e.g. REFUSED_STREAM) with a {@link TransportErrorReason};
 * classifyError then reads the structured tag instead of matching node:http2's
 * error-string details. This removes the fragile "substring uniqueness" invariant
 * (three transport error strings that must never overlap, maintained by hand +
 * unit tests) in favor of a tag the producer sets explicitly.
 *
 * The tag is a Symbol-keyed property so it never collides with anything on the
 * Error, survives `cause`-chaining (read recursively), and is invisible to
 * JSON/logging. Substring matching remains in classifyError as an explicit
 * defense-in-depth FALLBACK for errors that reach it WITHOUT a tag (an untagged
 * transport path, or an error surfaced by a layer that doesn't tag) — the tag is
 * authoritative when present.
 */

const TRANSPORT_REASON = Symbol("transportErrorReason")

/**
 * Why a transport-level upstream request failed. Retry semantics live in
 * classifyError; this enum only names the observable transport condition.
 * - `pre-response-close`: connection died before ANY response header (status 0,
 *   zero frames) — the `!headersReceived` close backstop. Retryable (reconnect).
 * - `refused-stream`: h2 REFUSED_STREAM (0x7) — peer refused before processing.
 *   Retryable (protocol zero-processing guarantee).
 * - `mid-body-close`: connection dropped AFTER headers, mid-body (`closed before
 *   end`). NOT a pre-response retry — a truncated body, surfaced as a stream error.
 * - `pool-closed`: OUR h2 session pool was torn down (shutdown force-close /
 *   finalize, or a test reset) under a request still acquiring or creating its
 *   session. A cancellation, not an upstream failure — retrying in-process is
 *   pointless, so boundaries surface it as a retryable-by-the-CLIENT 529.
 */
export type TransportErrorReason = "pre-response-close" | "refused-stream" | "mid-body-close" | "pool-closed"

/** Tag `err` with a structured transport reason and return it (for inline use at throw sites). */
export function tagTransportError<E extends Error>(err: E, reason: TransportErrorReason): E {
  ;(err as Error & { [TRANSPORT_REASON]?: TransportErrorReason })[TRANSPORT_REASON] = reason
  return err
}

/** Read the structured transport reason from `err` (or its `cause` chain); `undefined` if untagged. */
export function getTransportErrorReason(err: unknown): TransportErrorReason | undefined {
  if (!(err instanceof Error)) return undefined
  const tagged = (err as Error & { [TRANSPORT_REASON]?: TransportErrorReason })[TRANSPORT_REASON]
  if (tagged) return tagged
  if (err.cause instanceof Error) return getTransportErrorReason(err.cause)
  return undefined
}
