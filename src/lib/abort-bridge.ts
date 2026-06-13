/**
 * Bridge a Hono request's "client disconnected" signal into a downstream
 * `AbortController`. The handler creates a single `clientAbort` that gets
 * propagated to upstream fetch / WebSocket / pipeline, and this helper makes
 * the inbound HTTP signal a first-class trigger for it.
 *
 * Why this exists: prior to this helper, only the streaming branches called
 * `stream.onAbort()` to flip the controller — non-streaming branches did
 * nothing, so a client disconnect during a long non-stream response (thinking
 * models, 30-120s) left the upstream fetch running to completion, accumulating
 * response buffer the client would never read. Under high disconnect rate
 * this dramatically inflates peak heap residency.
 *
 * Why a helper (not `AbortSignal.any`): the rest of the codebase (stream.ts,
 * responses-client.ts, upstream-ws-connection.ts) uses explicit add/remove
 * pairs guarded by `finally`. Matching that style keeps the listener
 * lifecycle visible at every call site — important for an OOM-sensitive
 * proxy where observability beats brevity.
 */

import type { Context } from "hono"

/**
 * Wire `c.req.raw.signal` (Hono's "client disconnected" indicator) so that
 * aborting it also aborts `clientAbort`. Returns a `cleanup` function that
 * removes the listener — callers MUST invoke it in `finally`, otherwise the
 * (short-lived) raw.signal still leaks one listener per request until GC.
 *
 * Idempotent on the listener side: an already-aborted raw.signal triggers
 * `clientAbort.abort()` synchronously and returns a no-op cleanup. A missing
 * raw.signal (defensive — some test contexts) also returns a no-op cleanup.
 *
 * The listener is registered with `{ once: true }` for defense-in-depth: if
 * the caller forgets `finally`, the listener self-removes the moment abort
 * fires. The explicit `removeEventListener` in `cleanup` handles the normal
 * "request completed without disconnect" path where the abort event never
 * fires.
 */
export function bridgeClientAbort(c: Context, clientAbort: AbortController): () => void {
  const raw = c.req.raw.signal as AbortSignal | undefined
  if (!raw) return () => {}

  if (raw.aborted) {
    clientAbort.abort()
    return () => {}
  }

  const onAbort = () => clientAbort.abort()
  raw.addEventListener("abort", onAbort, { once: true })
  return () => raw.removeEventListener("abort", onAbort)
}
