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
 *
 * Consequence: the client echoes that server_tool_use{web_search} pair back in
 * its history next turn. Since the hops downgrade the `tools` array (native
 * web_search → plain function tool), the historical server_tool_use has no
 * matching server-tool definition and upstream 400s. The
 * `anthropic.rewrite_history_server_tools: "downgrade"` config closes that loop
 * by rewriting the historical pair into plain tool_use + tool_result inside
 * sanitizeAnthropicMessages (see sanitize/rewrite-server-tool-history.ts).
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

import { bridgeClientAbort } from "~/lib/abort-bridge"
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

import {
  //
  handleDirectAnthropicCompletion,
  startForwardedSseHeartbeat,
} from "./handler"

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

  // Single client-abort controller for the entire web-search lifecycle (probe +
  // optional second hop + synthesis). Bridged from the inbound HTTP signal so a
  // client disconnect at ANY point tears down the in-flight upstream call —
  // mirrors the pattern used by handler.ts / responses/handler.ts /
  // responses/fallback.ts. The streaming branch also wires `stream.onAbort`
  // below as a second trigger source (different runtime / proxy paths surface
  // the disconnect via one or the other).
  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)
  const inboundAbortSignal = clientAbort.signal

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
    detachClientAbort()
    throw error
  }

  // ── Pass-through: model did not search → re-dispatch the normal direct path ─
  if (!probe.toolUse) {
    consola.debug("[WebSearch] First hop did not request a search; re-dispatching through the direct path")
    // Record the probe's token cost so the otherwise-invisible first hop
    // (requestContext:undefined) is observable (原则3). The re-dispatch records
    // its own usage as the entry's primary usage.
    recordProbeWarning(reqCtx, probe)
    // The downstream `handleDirectAnthropicCompletion` installs its OWN
    // bridge from `c.req.raw.signal`. Detach ours first to avoid two
    // listeners racing on the same inbound signal.
    detachClientAbort()
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
      detachClientAbort()
      throw error
    }
    accumulateAndComplete(reqCtx, result, payload.model)
    detachClientAbort()
    return c.json(result.response)
  }

  // Streaming: transition BEFORE producing the response, then enter the SSE
  // stream and immediately emit a `ping` so the response headers flush and the
  // client's idle/body timeout clock resets while the second hop + search run.
  reqCtx.transition("streaming")
  return streamSSE(c, async (stream) => {
    // streamSSE.onAbort is the second trigger source — the inbound HTTP
    // signal bridge installed above is the first. Both flip the same
    // controller; the second call is a no-op per AbortController spec.
    stream.onAbort(() => clientAbort.abort())

    // Pings emitted on this client-facing stream (the upfront flush below +
    // any synthetic keepalives from `fake_sse_heartbeat` during the second
    // hop) are collected here and merged into the final forwardedSseEvents
    // so history reflects exactly what the client received. Indices use
    // `streamStartMs` so the timeline lines up with the synthesized event
    // sequence emitted at the end.
    const streamStartMs = Date.now()
    const prefixForwardedSse: Array<SseEventRecord> = []
    const heartbeat = startForwardedSseHeartbeat({
      intervalSec: state.anthropicFakeSseHeartbeat,
      stream,
      forwardedSseEvents: prefixForwardedSse,
      streamState: { streamStartMs, bytesIn: 0, eventsIn: 0, currentBlockType: "", firstEventLogged: false },
      clientAbortSignal: clientAbort.signal,
    })

    try {
      const upfrontPing = JSON.stringify({ type: "ping" })
      prefixForwardedSse.push({ offsetMs: 0, type: "ping", raw: upfrontPing })
      heartbeat.noteRealFrame()
      await heartbeat.writeSerialized({ event: "ping", data: upfrontPing })

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
        await heartbeat.writeSerialized({ event: "error", data: JSON.stringify({ type: "error", error: { type: "api_error", message } }) })
        return
      }

      const { events } = accumulateAndComplete(reqCtx, result, payload.model, prefixForwardedSse)
      for (const event of events) {
        heartbeat.noteRealFrame()
        await heartbeat.writeSerialized({ event: event.type, data: JSON.stringify(event) })
      }
    } finally {
      heartbeat.stop()
      detachClientAbort()
    }
  })
}

/**
 * Record the search sub-request, accumulate the synthesized events for History,
 * and finalize the request context. Returns the synthesized event sequence.
 *
 * `prefixForwardedSse` (streaming path only) carries any frames the client
 * already received before the synthesized events fire — currently the upfront
 * `ping` (always) plus any `fake_sse_heartbeat` pings emitted during the
 * second hop. They are prepended to the forwarded record so history reflects
 * what the client actually received, in order.
 */
function accumulateAndComplete(
  reqCtx: RequestContext,
  result: WebSearchOrchestrationResult,
  model: string,
  prefixForwardedSse?: ReadonlyArray<SseEventRecord>,
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
  // divergence on this double-hop path), so the forwarded record mirrors them —
  // with any pre-synthesis frames (upfront ping + heartbeat keepalives) prepended.
  const forwarded = prefixForwardedSse ? [...prefixForwardedSse, ...sseEvents] : sseEvents
  reqCtx.setForwardedResponse({ sseEvents: forwarded })
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
