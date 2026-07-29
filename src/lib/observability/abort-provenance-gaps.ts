/**
 * Abort-provenance GAP telemetry — the counter for "a cancellation arrived with no recorded cause".
 *
 * The provenance work (2026-07-28) made every cancellation source tag its abort reason, so the
 * boundaries can name the real cause instead of guessing. The two `unknown` terminals —
 * `unknown-cancel` (we know a request-lifecycle cancel happened, not which one) and `unknown-abort`
 * (we do not even know that much) — exist so a gap in that wiring is stated honestly rather than
 * papered over with a plausible-looking cause.
 *
 * But an honest value nobody counts is not a signal. Before this, an `unknown` reached the client
 * as the protocol's generic bucket (`api_error` / `server_error` / `INTERNAL`), indistinguishable
 * on `/metrics` from any other generic failure — the gap it was supposed to advertise could only
 * be found by opening an individual request in History. This makes it countable:
 *
 *   abort_provenance_gap_total{phase, surface}
 *
 * `phase` says WHERE the gap surfaced (which tells you which boundary to look at) and `surface`
 * which client protocol was in play. Both are small closed sets — deliberately NO request id, no
 * error message, no model: this is a "is anything leaking?" counter, and History already holds the
 * full text for whichever request you then go read.
 *
 * A non-zero count is an ACTION ITEM, not a health metric: some producer aborts without calling
 * `cancellationAbortError(...)`, or some transport rebuilds the error and drops the cause chain.
 *
 * Process-lifetime, in-memory, resets on restart — same class as `retry-giveups.ts`.
 */

/** Where the missing provenance surfaced. */
export type AbortProvenanceGapPhase =
  /** `forwardError` — nothing was committed yet, so the client still gets a real HTTP status. */
  | "pre-commit"
  /** Anthropic delayed-commit: we opened 200 SSE, upstream never sent response headers. */
  | "delayed-commit"
  /** `guardSseIterable` — the upstream body was already streaming. */
  | "post-header"

/** The client-facing protocol the gap surfaced on. `unknown` when the counting site cannot tell. */
export type AbortProvenanceGapSurface = "anthropic" | "openai-cc" | "openai-responses" | "gemini" | "unknown"

export interface AbortProvenanceGapCount {
  phase: AbortProvenanceGapPhase
  surface: AbortProvenanceGapSurface
  count: number
}

/** NUL joiner: occurs in neither literal set. */
const SEP = "\u0000"

let gaps = new Map<string, number>()

/** Record one cancellation that reached a boundary with no recorded cause. */
export function recordAbortProvenanceGap(phase: AbortProvenanceGapPhase, surface: AbortProvenanceGapSurface): void {
  const key = `${phase}${SEP}${surface}`
  gaps.set(key, (gaps.get(key) ?? 0) + 1)
}

/** Snapshot as structured rows (a fresh array — mutating it never affects the live counter). */
export function getAbortProvenanceGapCounts(): ReadonlyArray<AbortProvenanceGapCount> {
  return [...gaps].map(([key, count]) => {
    const sep = key.indexOf(SEP)
    return { phase: key.slice(0, sep) as AbortProvenanceGapPhase, surface: key.slice(sep + 1) as AbortProvenanceGapSurface, count }
  })
}

/** Test-only: reset the module-global counter (registered in RESETTERS). */
export function resetAbortProvenanceGapsForTests(): void {
  gaps = new Map()
}

/**
 * Client surface for a request path — for the boundaries that have no `RequestEnvelope` to read
 * `clientFormat` from (`forwardError` runs before/instead of the driver).
 *
 * Deliberately finer than `server.ts:detectErrorWireFormat`, which collapses Chat Completions and
 * Responses into one `openai`: those are separate legs with separate transports (one of which is
 * a WebSocket), so a gap on one must not be attributable to the other. Recording `unknown` here
 * would throw away information the path already carries.
 */
export function gapSurfaceForPath(path: string): AbortProvenanceGapSurface {
  if (path.startsWith("/v1beta")) return "gemini"
  if (path.startsWith("/responses") || path.startsWith("/v1/responses")) return "openai-responses"
  if (path.startsWith("/chat/completions") || path.startsWith("/v1/chat/completions") || path.startsWith("/embeddings") || path.startsWith("/v1/embeddings")) {
    return "openai-cc"
  }
  // Azure exposes both OpenAI shapes under /openai/deployments/<name>/<op>.
  if (path.startsWith("/openai")) return path.includes("/responses") ? "openai-responses" : "openai-cc"
  if (path.startsWith("/v1/messages")) return "anthropic"
  return "unknown"
}
