/**
 * Uniform terminal-settle decision for streaming endpoints.
 *
 * Every streaming handler (Anthropic Messages, OpenAI Chat Completions /
 * Responses / Responses-WS, Gemini, and the Responses→Chat-Completions
 * fallback) ends its pump in a `catch` that must decide between two terminal
 * states:
 *
 *   - client disconnected mid-stream → `abort()` (distinct `aborted` state; the
 *     stream is closed, so the caller must NOT write a client-facing error
 *     frame and should return immediately), or
 *   - any other failure → `fail()` (the caller then writes its endpoint's
 *     error frame to the still-open stream).
 *
 * That abort-vs-fail decision is identical across endpoints; only the
 * error-frame WIRE FORMAT differs (Anthropic SSE error / OpenAI SSE error /
 * Gemini data-frame / WS close). Centralizing the decision here — and leaving
 * the frame writing local to each handler — means a new streaming endpoint
 * cannot silently forget the abort semantics (it physically must call this to
 * settle), while not forcing the genuinely-divergent frame formats behind a
 * leaky shared abstraction.
 *
 * Returns `true` when the error was a client disconnect (caller: `return`
 * without writing to the stream). Returns `false` after calling `fail()`
 * (caller: write the endpoint-specific error frame).
 */

import type {
  //
  PartialResponseInfo,
  RequestContext,
} from "~/lib/context/request"

import { classifyStreamError } from "~/lib/stream"

export function settleStreamingFailure(opts: { reqCtx: RequestContext; error: unknown; model: string; partial?: PartialResponseInfo }): boolean {
  const { reqCtx, error, model, partial } = opts
  if (classifyStreamError(error) === "client-abort") {
    reqCtx.abort(model, partial)
    return true
  }
  reqCtx.fail(model, error, partial)
  return false
}
