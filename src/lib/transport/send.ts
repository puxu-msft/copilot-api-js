/**
 * Pure upstream HTTP send/receive — the format-agnostic skeleton shared by the
 * OpenAI Chat Completions and Responses clients (docs/v4/02-current-state.md §6.1).
 *
 * Extracts the common path: combine abort signals → fetch(DISABLE_BUILTIN_FETCH_TIMEOUT)
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

import consola from "consola"
import { events } from "fetch-event-stream"

import type { HeadersCapture } from "~/lib/context/request"

import { copilotBaseUrl } from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import {
  //
  captureHttpHeaders,
  createFetchSignal,
  DISABLE_BUILTIN_FETCH_TIMEOUT,
} from "~/lib/fetch-utils"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import { combineAbortSignals } from "~/lib/stream"
import { summarizeToolsForDiagnostics } from "~/lib/upstream-diagnostics"

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
   * Label reused for both the `consola.error` line and the thrown `HTTPError`
   * message (e.g. "Failed to create chat completions").
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
  const { endpointPath, headers, body, stream, errorLabel, modelId, diagnosticsTools, headersCapture, clientAbortSignal } = params

  // For non-streaming requests, fold the shutdown signal into the fetch signal so
  // a Phase 3 abort interrupts the (long) header-wait; streaming omits it (the
  // stream guard in the handler owns shutdown for the streamed body).
  // `clientAbortSignal` (when supplied) is always folded in so a client cancel
  // terminates both stream and non-stream paths.
  const fetchSignal = combineAbortSignals(createFetchSignal(), stream ? undefined : getShutdownSignal(), clientAbortSignal)

  const response = await fetch(`${copilotBaseUrl(state)}${endpointPath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: fetchSignal,
    ...DISABLE_BUILTIN_FETCH_TIMEOUT,
  })

  // Capture HTTP headers for history (before error check — capture even on failure)
  if (headersCapture) {
    captureHttpHeaders(headersCapture, headers, response)
  }

  if (!response.ok) {
    consola.error(errorLabel, response)
    // On opaque 400s, scan the wire tools for schema keywords / names the
    // upstream commonly rejects, and attach hint-only diagnostics.
    const diagnostics = response.status === 400 ? summarizeToolsForDiagnostics(diagnosticsTools) : undefined
    throw await HTTPError.fromResponse(errorLabel, response, modelId, diagnostics)
  }

  if (stream) {
    return events(response)
  }

  return response.json()
}
