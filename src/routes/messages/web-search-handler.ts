/**
 * Web search double-hop interception for the Anthropic /v1/messages route.
 *
 * Invoked from `handleMessages` when `web_search.enabled` is on and the request
 * carries a native web_search server tool. Runs the double-hop orchestration
 * (two non-streaming model hops + a real search) and emits a synthesized
 * response to the client:
 *   - non-streaming → a single JSON message
 *   - streaming → a synthesized SSE event sequence (mirrors warmup)
 *
 * Crucially, the synthesized server_tool_use + web_search_tool_result blocks are
 * sent DIRECTLY to the client, bypassing the unconditional server-tool-filter
 * applied on the normal `handleDirectAnthropic*Response` paths — so the search
 * results are visible to the client, which is the whole point of this feature.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { RequestContext } from "~/lib/context/request"
import type { SseEventRecord } from "~/lib/history/store"
import type { Model } from "~/lib/models/client"
import type { MessagesPayload } from "~/types/api/anthropic"

import {
  //
  accumulateAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "~/lib/anthropic/stream-accumulator"
import {
  //
  orchestrateWebSearch,
  webSearchResponseToEvents,
  type SearchExecutionResult,
  type WebSearchOrchestrationResult,
} from "~/lib/anthropic/web-search"
import { buildAnthropicResponseData } from "~/lib/request"
import { state } from "~/lib/state"

/**
 * Handle an Anthropic completion via the web_search double-hop.
 *
 * On a hard model-call failure, marks the request failed and rethrows (non-
 * streaming) or emits an Anthropic `error` SSE event (streaming, where headers
 * are already sent) so the client sees a clean failure.
 */
export async function handleWebSearchCompletion(c: Context, payload: MessagesPayload, reqCtx: RequestContext, resolvedModel: Model | undefined) {
  const clientAnthropicBeta = c.req.raw.headers.get("anthropic-beta") ?? undefined
  const isStream = payload.stream ?? false

  if (!isStream) {
    // Non-streaming: the inbound request's own abort signal fires on client
    // disconnect, terminating the (long, non-streaming) double-hop upstream work.
    const clientAbortSignal = c.req.raw.signal
    let result
    try {
      result = await orchestrateWebSearch({ payload, resolvedModel, clientAnthropicBeta, backend: state.webSearchBackend, clientAbortSignal })
    } catch (error) {
      reqCtx.fail(payload.model, error)
      throw error
    }
    accumulateAndComplete(reqCtx, result, payload.model)
    return c.json(result.response)
  }

  // Streaming: transition BEFORE producing the response, then enter the SSE
  // stream and immediately emit a `ping` so the response headers flush and the
  // client's idle/body timeout clock resets while the two hops + search run
  // (otherwise no byte would reach the client until all work finished).
  reqCtx.transition("streaming")
  return streamSSE(c, async (stream) => {
    // Abort the double-hop upstream work when the client disconnects mid-stream.
    const clientAbort = new AbortController()
    stream.onAbort(() => clientAbort.abort())

    await stream.writeSSE({ event: "ping", data: JSON.stringify({ type: "ping" }) })

    let result
    try {
      result = await orchestrateWebSearch({
        payload,
        resolvedModel,
        clientAnthropicBeta,
        backend: state.webSearchBackend,
        clientAbortSignal: clientAbort.signal,
      })
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
