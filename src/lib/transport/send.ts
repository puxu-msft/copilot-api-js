/**
 * Pure upstream HTTP send/receive — the format-agnostic skeleton shared by the
 * OpenAI Chat Completions and Responses clients (docs/v4/02-current-state.md §6.1).
 *
 * Extracts the common path: combine abort signals → undiciFetch(dispatcher)
 * → captureHttpHeaders → throw HTTPError on !ok → stream ? raw SSE events : json.
 *
 * P0.2 scope: adopted by the two OpenAI clients only. The Anthropic client keeps
 * its own fetch path this commit — its 2-attempt `invalid_reasoning_effort` inner
 * loop and `processAnthropicStream` are lifted later (P0.4 / P2.6). The adaptive
 * rate-limiter still wraps this at the call site (pipeline adapters), unchanged.
 *
 * Transitional shape: this returns the clients' current raw form (a raw SSE
 * `AsyncGenerator` when streaming, the parsed JSON body otherwise), NOT the P0.1
 * `UpstreamStream`/`Transport` contract. The driver adopts that contract in P2
 * (stream guard + boundary sampling move in then).
 */

import type { ServerSentEventMessage } from "fetch-event-stream"

import type { HeadersCapture } from "~/lib/context/request"

import { copilotBaseUrl } from "~/lib/copilot-api"
import {
  //
  HTTPError,
  isAbortError,
} from "~/lib/error"
import {
  //
  captureHttpHeaders,
  createResponseHeaderTimeoutSignal,
} from "~/lib/fetch-utils"
import {
  //
  getShutdownSignal,
  isShutdownCausedAbort,
  SHUTDOWN_ABORT_MESSAGE,
} from "~/lib/shutdown"
import { state } from "~/lib/state"
import { combineAbortSignals } from "~/lib/stream"
import { summarizeToolsForDiagnostics } from "~/lib/upstream-diagnostics"

import { upstreamFetch } from "./upstream-fetch"

/**
 * SSE source with eager ownership of the raw Response body.
 *
 * `fetch-event-stream.events(response)` is a lazy async generator: calling its
 * `return()` before the first `next()` does not enter the generator and therefore
 * never cancels `response.body`. A physical dispatch may be cancelled in exactly
 * that pre-consumer window. This wrapper closes the raw body directly until the
 * decoder has started; afterwards it delegates to the decoder's own return path.
 */
export function ownedResponseEvents(response: Response): AsyncIterable<ServerSentEventMessage> {
  type EventMessage = ServerSentEventMessage
  const decoded = parseOwnedSse(response)[Symbol.asyncIterator]()
  let started = false
  let closePromise: Promise<IteratorResult<EventMessage>> | undefined

  return {
    [Symbol.asyncIterator](): AsyncIterator<EventMessage> {
      return {
        next(): Promise<IteratorResult<EventMessage>> {
          started = true
          return decoded.next()
        },
        return(value?: EventMessage): Promise<IteratorResult<EventMessage>> {
          closePromise ??= (async () => {
            if (started) {
              await decoded.return(undefined)
              return { done: true, value: value as EventMessage }
            }
            await response.body?.cancel("Upstream dispatch disposed before SSE consumption")
            return { done: true, value: value as EventMessage }
          })()
          return closePromise
        },
      }
    },
  }
}

/** SSE decoder matching the previous fetch-event-stream field semantics while owning reader cleanup. */
async function* parseOwnedSse(response: Response): AsyncGenerator<ServerSentEventMessage> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let naturalEnd = false
  let event: ServerSentEventMessage | undefined

  const consumeLine = (line: string): ServerSentEventMessage | undefined => {
    if (line.length === 0) {
      const completed = event
      event = undefined
      return completed
    }
    const colon = line.indexOf(":")
    // Match the prior parser: comments (`:...`) and colon-less lines are ignored.
    if (colon <= 0) return undefined
    const field = line.slice(0, colon)
    const value = line.slice(colon + 1).replace(/^\s*/, "")
    switch (field) {
      case "data": {
        event ??= {}
        event.data = event.data ? `${event.data}\n${value}` : value
        break
      }
      case "event": {
        event ??= {}
        event.event = value
        break
      }
      case "id": {
        event ??= {}
        const numeric = Number(value)
        event.id = String(numeric) === value ? numeric : value
        break
      }
      case "retry": {
        event ??= {}
        event.retry = Number(value) || undefined
        break
      }
      default: {
        // Unknown SSE fields are ignored, matching the previous parser.
        break
      }
    }
    return undefined
  }

  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        naturalEnd = true
        text += decoder.decode()
      } else {
        text += decoder.decode(chunk.value, { stream: true })
      }

      let start = 0
      for (let index = 0; index < text.length; index++) {
        const code = text.codePointAt(index)
        if (code !== 10 && code !== 13) continue
        // A trailing CR may be the first half of CRLF split across chunks.
        if (code === 13 && index === text.length - 1 && !chunk.done) break
        const completed = consumeLine(text.slice(start, index))
        if (completed) yield completed
        if (code === 13 && text.codePointAt(index + 1) === 10) index++
        start = index + 1
      }
      text = text.slice(start)
      if (chunk.done) return
    }
  } finally {
    try {
      if (!naturalEnd) await reader.cancel("Upstream dispatch disposed during SSE consumption")
    } finally {
      reader.releaseLock()
    }
  }
}

/** Inputs for {@link sendUpstreamHttp} — the per-call wire plus error-shaping context. */
export interface SendUpstreamHttpParams {
  /** Path appended to `copilotBaseUrl(state)` (e.g. "/chat/completions", "/responses"). */
  endpointPath: string
  /** Outbound headers (already prepared + sanitized by the caller). */
  headers: Record<string, string>
  /** Wire payload object; JSON-stringified as the request body. */
  body: unknown
  /** Whether this is a streaming request (wire.stream) — truthy selects the SSE path. */
  stream: boolean | null | undefined
  /**
   * Label used as the thrown `HTTPError` message (e.g. "Failed to create chat
   * completions"). Not logged here — the driver's retry loop owns per-attempt
   * failure visibility (`[RETRY]` line via `recordAttemptFailure`) and the
   * error-forwarding layer owns terminal-failure logging (`[FAIL]` + the raw
   * upstream body), so a transport-level console line would only duplicate them.
   */
  errorLabel: string
  /** Model id attached to the thrown HTTPError (wire.model). */
  modelId: string | undefined
  /** Tools array scanned for hint-only diagnostics on opaque 400s (wire.tools). */
  diagnosticsTools: unknown
  /** Optional history header-capture sink. */
  headersCapture?: HeadersCapture
  /**
   * Downstream client-disconnect signal, folded into the upstream fetch signal.
   * Supplied by the Chat Completions client; omitted (undefined) by the Responses
   * HTTP path — `combineAbortSignals` drops undefined, so this stays byte-equivalent
   * to the call site that never folded it.
   */
  clientAbortSignal?: AbortSignal
  /**
   * Stale-request REAPER signal (`ctx.lifecycleSignal`), folded into the fetch so
   * the reaper can cancel the in-flight upstream during the (long) header-wait —
   * a DISTINCT provenance from `clientAbortSignal` (RFC §2 缺陷④); the streaming
   * guard also receives it separately so a mid-stream reap reaches a live client.
   */
  reaperSignal?: AbortSignal
  /** Candidate/dispatch-local cancellation signal (loser cancellation / force disposal). */
  dispatchSignal?: AbortSignal
  /**
   * When true, a fetch abort that {@link isShutdownCausedAbort} attributes to OUR
   * shutdown is rewritten to a retryable `HTTPError` 529 (overloaded), so the client
   * backs off and retries against the restarted instance — parity with the legacy
   * Anthropic client (client.ts:132-145). Off by default: every other caller (CC /
   * Responses / Gemini) re-throws the ORIGINAL AbortError object unchanged, preserving
   * its stack/identity/reason for the existing abort classification. A client-disconnect
   * abort NEVER becomes 529 (explicit guard), and neither does a reaper / hard-deadline
   * cancellation that merely happened during the drain. The Anthropic v4 transport opts in.
   */
  rewriteShutdownAbort?: boolean
  /** Best-effort HTTP/2 response-trailers sink (h2 path only); the driver wires it to `ctx.setOutboundResponseTrailers`. */
  onTrailers?: (trailers: Record<string, string>) => void
}

/**
 * Execute one upstream HTTP request and return the raw response shape: a raw SSE
 * `AsyncGenerator<ServerSentEventMessage>` for streaming requests, or the parsed
 * JSON body otherwise. Return type is `unknown` — the streaming and non-streaming
 * shapes have no common supertype, so callers cast to their format's response
 * union. Throws `HTTPError` on a non-ok response, with hint-only tool diagnostics
 * attached on opaque 400s.
 */
export async function sendUpstreamHttp(params: SendUpstreamHttpParams): Promise<unknown> {
  const {
    endpointPath,
    headers,
    body,
    stream,
    errorLabel,
    modelId,
    diagnosticsTools,
    headersCapture,
    clientAbortSignal,
    reaperSignal,
    dispatchSignal,
    rewriteShutdownAbort,
  } = params

  // Fold the stable shutdown signal into the fetch signal for BOTH streaming and non-streaming
  // requests so a Phase 3 abort interrupts the (long) header-wait (RFC RC1). The old
  // `stream ? undefined` exclusion was WRONG for the delayed-commit pre-response window: a
  // streaming request marked `streaming` can still be blocked in the pre-header fetch (`await p`)
  // where the stream-body guard does NOT yet exist, so shutdown could not reach it — the request
  // hung until Phase 4 force-close (observed 2026-07-12: Phase3 abort ineffective for 120s). The
  // stream-body guard still folds shutdown for the streamed body post-header (both aborting on
  // shutdown is idempotent). A shutdown-abort rewritten to a retryable 529 (below) is prevented
  // from spawning a new attempt by the driver's attempt-boundary cancel gate (RC1+RC3 atomic).
  // `clientAbortSignal` and `reaperSignal` (ctx.lifecycleSignal) are always folded too.
  const fetchSignal = combineAbortSignals(createResponseHeaderTimeoutSignal(modelId), getShutdownSignal(), clientAbortSignal, reaperSignal, dispatchSignal)

  let response: Response
  try {
    // upstreamFetch routes through undici + our keepalive/timeout dispatcher (see
    // upstream-fetch.ts). The Bun-only `{ timeout: false }` guard is gone — undici
    // has no built-in clock; timeouts come from the dispatcher's Agent.
    response = await upstreamFetch(`${copilotBaseUrl(state)}${endpointPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: fetchSignal,
      ...(params.onTrailers && { onTrailers: params.onTrailers }),
    })
  } catch (error) {
    // rewriteShutdownAbort (Anthropic v4 transport opt-in): an abort CAUSED BY OUR
    // SHUTDOWN becomes a retryable 529 (overloaded) — parity with the legacy Anthropic
    // client (client.ts:132-145) — so the client backs off and retries against the
    // restarted instance. Every other caller, and every other abort cause, re-throws the
    // ORIGINAL error object unchanged (preserving stack/identity/reason for the boundary
    // classification downstream).
    //
    // The gate is CAUSAL, not temporal: `isShutdownCausedAbort` matches the Phase 3 abort
    // reason object itself and `pool-closed` marks our own pool teardown. A plain
    // "are we shutting down?" flag would be wrong — a request cancelled during the
    // drain by the stale reaper or the hard deadline is not a shutdown, and neither is
    // a client that hung up in that window (hence the explicit client-signal guard,
    // which the old `getShutdownSignal().aborted` form was missing).
    //
    // The fetch signal's own reason is the second probe: a transport that synthesizes a
    // fresh AbortError instead of surfacing `signal.reason` would otherwise lose the
    // provenance. `fetchSignal.reason` is the FIRST aborted source's reason (AbortSignal.any
    // semantics), so this cannot mistake a reaper/deadline cancel for a shutdown.
    if (
      rewriteShutdownAbort
      && error instanceof Error
      && isAbortError(error)
      && !clientAbortSignal?.aborted
      && (isShutdownCausedAbort(error) || (fetchSignal?.aborted === true && isShutdownCausedAbort(fetchSignal.reason)))
    ) {
      throw new HTTPError(
        SHUTDOWN_ABORT_MESSAGE,
        529,
        JSON.stringify({ type: "error", error: { type: "overloaded_error", message: SHUTDOWN_ABORT_MESSAGE } }),
        modelId,
      )
    }
    throw error
  }

  // Capture HTTP headers for history (before error check — capture even on failure)
  if (headersCapture) {
    captureHttpHeaders(headersCapture, headers, response)
  }

  if (!response.ok) {
    // No console line here: this transport layer cannot know whether the caller
    // will retry (the driver decides that above, in runExchange's catch). Per-
    // attempt failure visibility is the driver's `[RETRY]` line; terminal-failure
    // logging is the error-forwarding layer's `[FAIL]` + raw-body line. Logging
    // the bare `Response` object here only ever printed a useless `{}`.
    // On opaque 400s, scan the wire tools for schema keywords / names the
    // upstream commonly rejects, and attach hint-only diagnostics.
    const diagnostics = response.status === 400 ? summarizeToolsForDiagnostics(diagnosticsTools) : undefined
    throw await HTTPError.fromResponse(errorLabel, response, modelId, diagnostics)
  }

  if (stream) {
    return ownedResponseEvents(response)
  }

  return response.json()
}
