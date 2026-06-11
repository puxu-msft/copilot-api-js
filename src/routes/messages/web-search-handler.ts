/**
 * Web search double-hop interception for the Anthropic /v1/messages route.
 *
 * Invoked from `handleMessages` when `web_search.enabled` is on and the request
 * carries a native web_search server tool (or Claude Code's WebSearch). Runs a
 * non-streaming FIRST-HOP PROBE so the main model can decide whether to search,
 * then branches:
 *   - NO search (pass-through, the common case) → re-dispatch the request
 *     through the NORMAL direct path (`handleDirectAnthropicCompletion`), so it
 *     gets real streaming, the thinking-signature shim, correct tool_use
 *     streaming, and full history — instead of a synthesized fake stream. This
 *     is what fixes corrupt thinking blocks and removes the fake-stream tax for
 *     the common no-search case.
 *   - search → run the second hop + synthesis and emit a synthesized response
 *     (non-streaming → a single JSON message; streaming → a synthesized SSE
 *     sequence).
 *
 * Crucially, on the search path the synthesized server_tool_use +
 * web_search_tool_result blocks are sent DIRECTLY to the client, bypassing the
 * unconditional server-tool-filter applied on the normal `handleDirectAnthropic*`
 * paths — so the search results are visible to the client.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { RequestContext } from "~/lib/context/request"
import type {
  //
  PreprocessInfo,
  SseEventRecord,
} from "~/lib/history/store"
import type { Model } from "~/lib/models/client"
import type { MessagesPayload } from "~/types/api/anthropic"

import {
  //
  accumulateAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "~/lib/anthropic/stream-accumulator"
import {
  //
  completeWebSearch,
  runFirstHopProbe,
  webSearchResponseToEvents,
  type SearchExecutionResult,
  type WebSearchOrchestrationResult,
  type WebSearchProbeResult,
} from "~/lib/anthropic/web-search"
import { buildAnthropicResponseData } from "~/lib/request"
import { state } from "~/lib/state"

import { handleDirectAnthropicCompletion } from "./handler"

/**
 * Handle an Anthropic completion via the web_search double-hop.
 *
 * On a hard model-call failure, marks the request failed and rethrows (non-
 * streaming) or emits an Anthropic `error` SSE event (streaming, where headers
 * are already sent) so the client sees a clean failure.
 */
export async function handleWebSearchCompletion(
  c: Context,
  payload: MessagesPayload,
  reqCtx: RequestContext,
  resolvedModel: Model | undefined,
  preprocessInfo: PreprocessInfo,
) {
  const clientAnthropicBeta = c.req.raw.headers.get("anthropic-beta") ?? undefined
  const isStream = payload.stream ?? false
  // The inbound request's own abort signal fires on client disconnect, ending
  // the (long, non-streaming) probe/hop upstream work. The streaming search path
  // wires a per-stream controller inside streamSSE below.
  const inboundAbortSignal = c.req.raw.signal

  // ── First-hop probe (non-streaming): decide whether to search ────────────
  // Runs BEFORE any client bytes are owed, so a no-search outcome can re-dispatch
  // the request through the normal direct path. runFirstHopProbe → callMainModel
  // uses requestContext:undefined, so the probe never touches reqCtx — leaving
  // it pristine (pending, settled:false, no attempts) for the re-dispatch.
  let probe: WebSearchProbeResult
  try {
    probe = await runFirstHopProbe({ payload, resolvedModel, clientAnthropicBeta, backend: state.webSearchBackend, clientAbortSignal: inboundAbortSignal })
  } catch (error) {
    reqCtx.fail(payload.model, error)
    throw error
  }

  // ── Pass-through: model did not search → re-dispatch the normal direct path ─
  if (!probe.toolUse) {
    consola.debug("[WebSearch] First hop did not request a search; re-dispatching through the direct path")
    // Record the probe's token cost so the otherwise-invisible first hop
    // (requestContext:undefined) is observable (原则3). The re-dispatch records
    // its own usage as the entry's primary usage.
    recordProbeWarning(reqCtx, probe)
    return handleDirectAnthropicCompletion(c, payload, reqCtx, preprocessInfo)
  }

  // ── Search path: run second hop + synthesis, emit synthesized response ────
  if (!isStream) {
    let result
    try {
      result = await completeWebSearch(
        { payload, resolvedModel, clientAnthropicBeta, backend: state.webSearchBackend, clientAbortSignal: inboundAbortSignal },
        probe,
      )
    } catch (error) {
      reqCtx.fail(payload.model, error)
      throw error
    }
    accumulateAndComplete(reqCtx, result, payload.model)
    return c.json(result.response)
  }

  // Streaming: transition BEFORE producing the response, then enter the SSE
  // stream and immediately emit a `ping` so the response headers flush and the
  // client's idle/body timeout clock resets while the second hop + search run.
  reqCtx.transition("streaming")
  return streamSSE(c, async (stream) => {
    // Abort the remaining upstream work when the client disconnects mid-stream.
    const clientAbort = new AbortController()
    stream.onAbort(() => clientAbort.abort())

    await stream.writeSSE({ event: "ping", data: JSON.stringify({ type: "ping" }) })

    let result
    try {
      result = await completeWebSearch(
        { payload, resolvedModel, clientAnthropicBeta, backend: state.webSearchBackend, clientAbortSignal: clientAbort.signal },
        probe,
      )
    } catch (error) {
      // Headers are already sent — surface as an Anthropic error event, then end.
      reqCtx.fail(payload.model, error)
      const message = error instanceof Error ? error.message : String(error)
      await stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", error: { type: "api_error", message } }) })
      return
    }

    const { events } = accumulateAndComplete(reqCtx, result, payload.model)
    for (const event of events) {
      await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
    }
  })
}

/**
 * Record the search sub-request, accumulate the synthesized events for History,
 * and finalize the request context. Returns the synthesized event sequence.
 */
function accumulateAndComplete(
  reqCtx: RequestContext,
  result: WebSearchOrchestrationResult,
  model: string,
): { events: ReturnType<typeof webSearchResponseToEvents> } {
  // Record the search sub-request (query, backend outcome, result count) into
  // history as a structured warning so the search step is observable (原则3).
  if (result.search) recordSearchWarning(reqCtx, result.search)

  // Surface dropped parallel searches (round limit = 1) so the truncation is
  // observable rather than silent (原则3).
  if (result.droppedSearchCount) {
    reqCtx.addWarningMessage({
      code: "web_search_dropped_searches",
      message: `First hop requested ${result.droppedSearchCount + 1} parallel searches; round limit is 1, dropped ${result.droppedSearchCount} (v1 limitation).`,
    })
  }

  // Rebuild an accumulator from the synthesized events so History records the
  // exact block sequence the client receives (server_tool_use → result → text),
  // and capture the synthesized SSE events for the history debug view.
  const events = webSearchResponseToEvents(result.response)
  const acc = createAnthropicStreamAccumulator()
  const sseEvents: Array<SseEventRecord> = []
  const startMs = Date.now()
  for (const event of events) {
    accumulateAnthropicStreamEvent(event, acc)
    sseEvents.push({ offsetMs: Date.now() - startMs, type: event.type, raw: JSON.stringify(event) })
  }
  reqCtx.setSseEvents(sseEvents)
  // The synthesized events ARE exactly what the client receives (no upstream/forward
  // divergence on this double-hop path), so the forwarded record mirrors them.
  reqCtx.setForwardedResponse({ sseEvents })
  reqCtx.complete(buildAnthropicResponseData(acc, model))
  return { events }
}

/** Record the search sub-request outcome as a structured history warning. */
function recordSearchWarning(reqCtx: RequestContext, search: SearchExecutionResult): void {
  const summary = {
    backend: state.webSearchBackend || "<none>",
    query: search.query,
    model: search.model,
    resultCount: search.results.length,
    ok: search.ok,
    inputTokens: search.inputTokens,
    outputTokens: search.outputTokens,
    ...(search.ok ? {} : { detail: search.text.split("\n").slice(0, 3).join(" ") }),
  }
  consola.debug(`[WebSearch] Recorded search sub-request: ${summary.resultCount} results (ok=${summary.ok})`)
  reqCtx.addWarningMessage({ code: "web_search_subrequest", message: JSON.stringify(summary) })
}

/**
 * Record the pass-through first-hop probe's token cost as a structured history
 * warning. The probe runs with requestContext:undefined (so its usage never
 * lands in the entry's primary usage), but the user still paid for it — surface
 * it so the cost is observable rather than silently dropped (原则3).
 */
function recordProbeWarning(reqCtx: RequestContext, probe: WebSearchProbeResult): void {
  // usage is required on a successful Anthropic response (same trust as
  // mergeUsage); fields are defaulted defensively below.
  const usage = probe.firstResponse.usage as { input_tokens?: number; output_tokens?: number }
  const summary = {
    phase: "first_hop_probe",
    searched: false,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  }
  consola.debug(`[WebSearch] Pass-through probe spent ${summary.inputTokens}+${summary.outputTokens} tokens (re-dispatching)`)
  reqCtx.addWarningMessage({ code: "web_search_probe", message: JSON.stringify(summary) })
}
