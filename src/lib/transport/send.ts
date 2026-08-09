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
import type {
  //
  ParsedSseFrame,
  ParsedSseIdField,
} from "~/lib/transport/parsed-sse-frame"

import { copilotBaseUrl } from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { captureHttpHeaders } from "~/lib/fetch-utils"
import { resolveResponseHeaderTimeoutMs } from "~/lib/models/timeout-resolver"
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
export function ownedResponseEvents(response: Response): AsyncIterable<ParsedSseFrame> {
  type EventMessage = ParsedSseFrame
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

/**
 * WHATWG-compatible SSE decoder that owns reader cleanup.
 *
 * The event-stream interpretation algorithm requires pending data without a
 * terminating blank line to be discarded at EOF, rather than flushed.
 * https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
 */
async function* parseOwnedSse(response: Response): AsyncGenerator<ParsedSseFrame> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let naturalEnd = false
  let dataBuffer = ""
  let sawDataField = false
  let eventType = ""
  let retry: number | undefined
  let lastEventIdBuffer = ""
  let lastEventIdString = ""
  let idField: ParsedSseIdField = { kind: "absent" }

  const resetEventBuffers = () => {
    dataBuffer = ""
    sawDataField = false
    eventType = ""
    retry = undefined
    idField = { kind: "absent" }
  }

  const consumeLine = (line: string): ParsedSseFrame | undefined => {
    if (line.length === 0) {
      lastEventIdString = lastEventIdBuffer
      if (!sawDataField) {
        resetEventBuffers()
        return undefined
      }

      const message: ServerSentEventMessage & { id: string } = {
        data: dataBuffer.slice(0, -1),
        id: lastEventIdString,
      }
      if (eventType) message.event = eventType
      if (retry !== undefined) message.retry = retry
      const completed: ParsedSseFrame = { kind: "parsed-sse", message, idField }
      resetEventBuffers()
      return completed
    }

    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    switch (field) {
      case "data": {
        sawDataField = true
        dataBuffer += `${value}\n`
        break
      }
      case "event": {
        eventType = value
        break
      }
      case "id": {
        if (!value.includes("\0")) {
          lastEventIdBuffer = value
          idField = { kind: "present", value }
        }
        break
      }
      case "retry": {
        if (/^\d+$/.test(value)) retry = Number(value)
        break
      }
      default: {
        // Unknown SSE fields and comments are ignored.
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
  const { endpointPath, headers, body, stream, errorLabel, modelId, diagnosticsTools, headersCapture, clientAbortSignal, reaperSignal, dispatchSignal } = params

  // Fold request-owned lifecycle cancellation into the fetch. The response-header
  // deadline is passed separately so it is disarmed before body consumption. Shutdown
  // contributes no signal because the first process signal must not cancel accepted work.
  const fetchSignal = combineAbortSignals(clientAbortSignal, reaperSignal, dispatchSignal)

  // upstreamFetch routes through undici + our keepalive/timeout dispatcher (see
  // upstream-fetch.ts). The Bun-only `{ timeout: false }` guard is gone — undici
  // has no built-in clock; timeouts come from the dispatcher's Agent.
  const response = await upstreamFetch(`${copilotBaseUrl(state)}${endpointPath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: fetchSignal,
    responseHeaderTimeoutMs: resolveResponseHeaderTimeoutMs(modelId),
    ...(params.onTrailers && { onTrailers: params.onTrailers }),
  })

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
