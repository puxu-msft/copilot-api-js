/**
 * v4 driver path for Chat Completions (P2.3).
 *
 * The Chat Completions route dispatches here (the v4 driver path — the only path
 * since P3.3 removed the legacy `handleChatCompletion`). Builds a
 * per-request driver (codec + HTTP transport + env strategies) and drives the
 * seven stages, keeping behavior equivalent to the legacy handler.
 *
 * Division of labor (Stage B CC cut-over — owns-the-sink streaming): the DRIVER owns the
 * client write-out (`runResponseSink` writes each rendered frame to a `makeSseSink`); this
 * route does the rendered-frame-side work through the driver's `onRenderedFrame` hook
 * (accumulate + progress + the forwarded-only tool-name restore), samples the forwarded track
 * inside the sink (`onForwarded`), synthesizes the verbose truncation marker + the trailing
 * `[DONE]` (P2.2-D2), and maps the outcome to `complete`/`fail`/`abort`. The H3 error frame is
 * built inline (raw upstream message) rather than via `codec.formatError` (P2.2-D4 — formatError
 * only gets the classified kind; the consumer has the raw error, so it matches legacy).
 * The non-streaming path still renders + settles directly (no sink).
 */

import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { SseEventRecord } from "~/lib/history"
import type { Model } from "~/lib/models/client"
import type { OpenAIAutoTruncateResult } from "~/lib/openai/auto-truncate"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
  DriverRequestResult,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { ToolNameMapper } from "~/lib/tool-name-mapper"
import type {
  //
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/types/api/openai-chat-completions"

import { bridgeClientAbort } from "~/lib/abort-bridge"
import { createOpenAiCcCodec } from "~/lib/codec/openai-cc/codec"
import { buildOpenAiCcStrategies } from "~/lib/codec/openai-cc/strategies"
import { ALL_RESPONSE_REWRITES } from "~/lib/codec/response-rewrite-registry"
import { HTTPError } from "~/lib/error"
import { ENDPOINT } from "~/lib/models/endpoint"
import { resolveModelTarget } from "~/lib/models/resolver"
import {
  //
  createTruncationResponseMarkerOpenAI,
} from "~/lib/openai/auto-truncate"
import {
  //
  accumulateOpenAIStreamEvent,
  createOpenAIStreamAccumulator,
} from "~/lib/openai/stream-accumulator"
import { openAIStreamErrorFrame } from "~/lib/openai/stream-error"
import {
  //
  restoreChatCompletionsChunkToolNames,
  restoreChatCompletionsToolNames,
} from "~/lib/openai/tool-name-sanitize"
import { makeSseSink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { openaiNonStreamingTruncation } from "~/lib/pipeline/non-streaming-completeness"
import {
  //
  buildOpenAIResponseData,
  usageFromTotalInput,
} from "~/lib/request"
import { state } from "~/lib/state"
import { processOpenAIMessages } from "~/lib/system-prompt"
import { createUpstreamHttpTransport } from "~/lib/transport/http-transport"

/** CC has no learning-budget strategy; the value is inert (passed for completeness). */
const MAX_LEARNING_RETRIES = 32

/**
 * Restore tool-call names (upstream → original) in a single CC SSE `data` frame.
 * Best-effort: input unchanged on `[DONE]` / empty / unparseable / no-op / null
 * mapper (a malformed frame never aborts the forward loop). Mirrors the legacy
 * handler's helper byte-for-byte.
 */
function restoreStreamToolNames(data: string | undefined, mapper: ToolNameMapper | null): string {
  if (!mapper || !data || data === "[DONE]") return data ?? ""
  let chunk: unknown
  try {
    chunk = JSON.parse(data)
  } catch {
    return data
  }
  return restoreChatCompletionsChunkToolNames(chunk, mapper) ? JSON.stringify(chunk) : data
}

export async function handleChatCompletionV4(c: Context): Promise<Response> {
  const clientRaw = (c.get("injectedPayload") as ChatCompletionsPayload | undefined) ?? (await c.req.json<ChatCompletionsPayload>())
  const azureModelOverride = c.get("azureModelOverride") as string | undefined

  // P2.2-D3: apply the async, non-idempotent system-prompt injection to the wire
  // body BEFORE the sync codec.parse, passing the client raw separately for the
  // history snapshot. System-prompt uses the resolved model name (override rules).
  //
  // Resolve the model HERE (before processOpenAIMessages' config reload) and pass
  // it to parse as `preResolved`, matching the legacy handler's order (read model
  // → then system-prompt reload). Otherwise a `disabled_models` reload during
  // system-prompt would shift parse's model lookup vs. legacy.
  const { name: resolvedName, routeOverride } = resolveModelTarget(azureModelOverride ?? clientRaw.model)
  const selectedModel = state.modelIndex.get(resolvedName)
  const wireMessages = await processOpenAIMessages(clientRaw.messages, resolvedName)
  const wireBody: ChatCompletionsPayload = { ...clientRaw, messages: wireMessages }

  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)
  const codec = createOpenAiCcCodec()
  const transport = createUpstreamHttpTransport({ clientAbortSignal: clientAbort.signal, idleTimeoutMs: state.streamIdleTimeout * 1000 })

  // Truncation result for the response marker (captured from the strategy factory).
  let truncateResult: OpenAIAutoTruncateResult | undefined

  const driver = createPipelineDriver({
    codec,
    transport,
    // Full-format S5 union (RFC §7.1). Inert for the CC-inbound legs today (no rewrite's
    // `appliesTo` matches targetEndpoint ∈ {/chat/completions, /responses} for clientFormat
    // openai-cc); it carries the mechanism for the future reverse leg (cc→/v1/messages, Phase 5).
    responseRewrites: ALL_RESPONSE_REWRITES,
    strategies: (env) => {
      const viaResponses = env.targetEndpoint === ENDPOINT.RESPONSES
      if (viaResponses) env.ctx.recordFeature("via-responses") // P2.2-D6
      return buildOpenAiCcStrategies({
        originalPayload: codec.getTruncateBaseline() ?? (env.body as ChatCompletionsPayload),
        model: env.model as Model | undefined,
        maxRetries: state.autoTruncateMaxRetries,
        label: viaResponses ? "Completions(→Responses)" : "Completions",
      })
    },
    maxRetries: state.autoTruncateMaxRetries,
    maxLearningRetries: MAX_LEARNING_RETRIES,
    // Post-gate meta sink (C0-② / RFC §11.2): the auto-truncate strategy's
    // truncateResult, routed here only after the budget gate accepts the retry —
    // so a budget-rejected truncate retry no longer sets a phantom `truncated`
    // feature/marker (the pre-gate adapter onMeta used to).
    onMeta: (meta, metaEnv) => {
      const result = meta.truncateResult as OpenAIAutoTruncateResult | undefined
      if (result) {
        truncateResult = result
        metaEnv.ctx.recordFeature("truncated")
      }
    },
  })

  let result: DriverRequestResult
  try {
    result = await driver.runRequest({
      body: wireBody,
      originalBodyForHistory: clientRaw,
      headers: c.req.raw.headers,
      method: c.req.method,
      path: c.req.path,
      preResolved: { name: resolvedName, model: selectedModel, ...(routeOverride && { routeOverride }) },
      ...(azureModelOverride !== undefined && { modelOverride: azureModelOverride }),
      clientAbortSignal: clientAbort.signal,
    })
  } catch (error) {
    // Any failure after parse created the ctx (parse-period sanitize/translate
    // throw, or an exchange failure). Settle it — `codec.getContext()` reaches the
    // ctx even when the throw happened before the envelope was otherwise capturable.
    // (Outbound header legs are written by the driver during the exchange, RFC Phase 2.)
    const ctx = codec.getContext()
    if (ctx) {
      c.set("requestContext", ctx)
      ctx.fail(resolvedName, error)
    }
    detachClientAbort()
    throw error
  }

  // Expose the ctx on the request so the observability middleware's non-streaming
  // safety net can finalize it from the HTTP status if a path below doesn't settle
  // it (parity with legacy handler.ts c.set("requestContext")).
  const ctx = codec.getContext()
  if (ctx) c.set("requestContext", ctx)

  if (!result.ok) {
    // decideRoute reject — shape the OpenAI 400 (route's forwardError finishes it;
    // the middleware finalizes the now-c.set ctx from the 4xx status).
    detachClientAbort()
    throw new HTTPError(result.rejection.reason, result.rejection.status, result.rejection.reason)
  }

  const { upstream, env } = result

  if (!env.stream) {
    try {
      const ccResp = driver.runResponseNonStreaming(upstream, env) as ChatCompletionResponse
      return renderNonStreamingV4(c, env, ccResp, truncateResult)
    } finally {
      detachClientAbort()
    }
  }

  consola.debug("[ChatCompletions:v4] Streaming response")
  env.ctx.transition("streaming")
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => clientAbort.abort())
    // RFC Phase 4: ④ capture proxy→client response headers (set by streamSSE before this callback).
    env.ctx.setInboundResponseHeaders(Object.fromEntries(c.res.headers.entries()))
    env.ctx.setClientResponseStatus(c.res.status)
    try {
      await pumpStreamingV4({ stream, driver, upstream, env, getTruncateResult: () => truncateResult })
    } finally {
      detachClientAbort()
    }
  })
}

// ============================================================================
// Non-streaming render
// ============================================================================

function renderNonStreamingV4(
  c: Context,
  env: RequestEnvelope,
  originalResponse: ChatCompletionResponse,
  truncateResult: OpenAIAutoTruncateResult | undefined,
): Response {
  let response = originalResponse
  if (state.verbose && truncateResult?.wasTruncated && response.choices[0]?.message.content) {
    const marker = createTruncationResponseMarkerOpenAI(truncateResult)
    const firstChoice = response.choices[0]
    response = {
      ...response,
      choices: [{ ...firstChoice, message: { ...firstChoice.message, content: `${marker}${firstChoice.message.content}` } }, ...response.choices.slice(1)],
    }
  }

  const choice = response.choices.at(0)
  const usage = response.usage

  // Restore tool_call names (upstream → original) on the client-facing response.
  const clientResponse = restoreChatCompletionsToolNames(response, env.ctx.toolNameMapper)

  env.ctx.setForwardedResponse({ content: clientResponse.choices[0]?.message })
  // RFC Phase 4: ④ build the client response first, capture its headers, THEN complete.
  const httpResponse = c.json(clientResponse)
  env.ctx.setInboundResponseHeaders(Object.fromEntries(httpResponse.headers.entries()))
  env.ctx.setClientResponseStatus(httpResponse.status)

  // Non-streaming semantic-truncation gate. `.at(0)` (not `[0]`) so an EMPTY choices
  // array (itself a truncation form) flows through as a missing finish_reason → fail,
  // rather than throwing a TypeError before the gate.
  const truncationReason = openaiNonStreamingTruncation(choice?.finish_reason)
  const responseData = {
    success: !truncationReason,
    model: response.model,
    // `usage.prompt_tokens` is the TOTAL prompt incl cached; normalize to the
    // canonical net convention (input_tokens disjoint from cache_read).
    usage: usageFromTotalInput({
      totalInput: usage?.prompt_tokens ?? 0,
      output: usage?.completion_tokens ?? 0,
      cacheRead: usage?.prompt_tokens_details?.cached_tokens,
      reasoning: usage?.completion_tokens_details?.reasoning_tokens,
    }),
    stop_reason: choice?.finish_reason ?? undefined,
    content: choice?.message,
  }
  if (truncationReason) {
    env.ctx.fail(response.model, new Error(truncationReason), {
      usage: responseData.usage,
      stop_reason: responseData.stop_reason,
      content: responseData.content,
    })
  } else {
    env.ctx.complete(responseData)
  }

  return httpResponse
}

// ============================================================================
// Streaming pump
// ============================================================================

interface PumpStreamingV4Options {
  stream: SSEStreamingApi
  driver: ReturnType<typeof createPipelineDriver>
  upstream: UpstreamStream
  env: RequestEnvelope
  getTruncateResult: () => OpenAIAutoTruncateResult | undefined
}

/**
 * Stream pump for the v4 Chat Completions path — **owns-the-sink** (Stage B CC cut-over).
 * The driver OWNS the client write-out: it drives the S5 chain (empty for CC) + S6 render
 * (identity for passthrough, Responses→CC translation for via-responses) and writes each
 * frame to the injected {@link makeSseSink}, returning a control-signal {@link import("~/lib/pipeline/types").ResponseOutcome}.
 * This handler:
 *   - does its rendered-frame-side work in the driver's `onRenderedFrame` hook (the
 *     post-render counterpart of Anthropic's pre-rewrite `onUpstreamFrame`): per frame it
 *     accumulates (UPSTREAM names → the terminal `complete` data), records progress, and
 *     RETURNS the tool-name-RESTORED frame to forward (forwarded-only — the driver's raw
 *     upstream-track sampling keeps the upstream names in history),
 *   - samples the FORWARDED track INSIDE the sink (`onForwarded` → `forwardedSseEvents`):
 *     the verbose marker (written first), every restored content frame, and the synthesized
 *     trailing `[DONE]` all flow through `sink.write` (sampled); the H3 error frame goes
 *     through the NON-sampling `sink.writeSynthetic` (legacy CC never recorded it),
 *   - synthesizes the SINGLE trailing `[DONE]` itself (the driver drops every upstream
 *     `[DONE]`; passthrough AND via-responses both terminate with exactly one — P2.2-D2),
 *   - maps the outcome + its own accumulator to the terminal ctx state. CC has no terminal
 *     upstream `error` frame (no H2 — the OpenAI accumulator tracks no `streamError`), so the
 *     only failure path is H3 (`stream-error`) / client-abort (`settled-abort`).
 *
 * CC has no fake-SSE heartbeat (Anthropic-only), so the sink runs no forward-idle racer.
 */
async function pumpStreamingV4(opts: PumpStreamingV4Options): Promise<void> {
  const { stream, driver, upstream, env } = opts
  const acc = createOpenAIStreamAccumulator()
  const mapper = env.ctx.toolNameMapper
  const model = (env.body as ChatCompletionsPayload).model

  // Forwarded SSE frames — what the client ACTUALLY received (tool-name restored). Filled by
  // the sink's `onForwarded` sampler; the upstream-original track is the driver's (runResponse
  // loop-top samples the raw frames before render).
  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  let bytesIn = 0
  let eventsIn = 0

  // The driver-owned client sink: SSE write-out + forwarded sampling. No heartbeat (CC has
  // no stream_keepalive_ping_sec). The sink preserves SSE id/retry framing it is given.
  const sink = makeSseSink(stream, {
    onForwarded: (record) => forwardedSseEvents.push(record),
    streamStartMs,
  })
  const recordForwarded = (): void => env.ctx.setForwardedResponse({ sseEvents: [...forwardedSseEvents] })

  // Verbose truncation marker as the FIRST forwarded chunk (before the driver loop). The sink
  // samples it (event: "message"); `acc.rawContent` records it so the accumulated completion
  // data includes the marker (legacy parity).
  const truncateResult = opts.getTruncateResult()
  if (state.verbose && truncateResult?.wasTruncated) {
    const marker = createTruncationResponseMarkerOpenAI(truncateResult)
    const markerChunk: ChatCompletionChunk = {
      id: `truncation-marker-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: marker }, finish_reason: null, logprobs: null }],
    }
    await sink.write({ data: JSON.stringify(markerChunk), event: "message" })
    acc.rawContent += marker
  }

  // Per rendered frame (post-S6, pre-write): progress + accumulate on the UPSTREAM-named frame
  // (the accumulated completion data keeps upstream names) + return the RESTORED frame for
  // forwarding (id/retry/event preserved by the spread; the sink writes them). The driver
  // drops `[DONE]` before this fires.
  const onRenderedFrame = (frame: ClientFrame): ClientFrame => {
    bytesIn += frame.data?.length ?? 0
    eventsIn++
    env.ctx.recordStreamProgress({ bytesIn, eventsIn })
    if (frame.data) {
      try {
        accumulateOpenAIStreamEvent(JSON.parse(frame.data) as ChatCompletionChunk, acc)
      } catch (err) {
        consola.debug(`[ChatCompletions:v4] skipping unparseable SSE frame (${err instanceof Error ? err.message : String(err)}):`, frame.data.slice(0, 200))
      }
    }
    return { ...frame, data: restoreStreamToolNames(frame.data, mapper) }
  }

  const outcome = await driver.runResponseSink(upstream, env, sink, { onRenderedFrame })

  if (outcome.kind === "settled-abort") {
    // Client disconnected mid-stream — write ZERO further bytes (B0-d). Record what was
    // forwarded so far, then settle as aborted (mirrors settleStreamingFailure's abort branch).
    recordForwarded()
    consola.debug("[ChatCompletions:v4] Client disconnected mid-stream — recording aborted")
    env.ctx.abort(acc.model || model, {
      usage: usageFromTotalInput({ totalInput: acc.inputTokens, output: acc.outputTokens, cacheRead: acc.cachedTokens, reasoning: acc.reasoningTokens }),
    })
    return
  }

  if (outcome.kind === "stream-error") {
    // H3 — the upstream iterable (or a sink write) threw a non-abort error. Write the OpenAI error
    // frame + record it into the forwarded track (the client receives it), THEN settle. Ordering is
    // load-bearing: writeSynthetic samples the frame, recordForwarded snapshots it, and only then does
    // ctx.fail() freeze inboundResponse — a post-fail snapshot would miss the client-received frame.
    const error = outcome.error
    consola.error("[ChatCompletions:v4] Stream error:", error)
    await sink.writeSynthetic?.(openAIStreamErrorFrame(error)).catch(() => undefined)
    recordForwarded()
    env.ctx.fail(acc.model || model, error, {
      usage: usageFromTotalInput({ totalInput: acc.inputTokens, output: acc.outputTokens, cacheRead: acc.cachedTokens, reasoning: acc.reasoningTokens }),
    })
    return
  }

  // outcome.kind === "complete" — the upstream drained cleanly. Synthesize the SINGLE trailing
  // `[DONE]` (the driver dropped every upstream one; passthrough + via-responses both terminate
  // with exactly one — P2.2-D2). `sink.write` samples it (type: "message") into the forwarded
  // track before the snapshot.
  if (acc.finishReason === "") {
    // Truncation: the rendered stream never carried a finish_reason — a complete OpenAI stream
    // always terminates with one, so a clean drain without it means the upstream truncated
    // mid-stream. Emit an OpenAI error frame instead of the normal `[DONE]` (so the client gets a
    // clean terminator) + record it into the forwarded track, THEN settle FAIL preserving the
    // partial. Order: writeSynthetic → recordForwarded → fail. See docs/spec/upstream-stream-truncation-detection.md.
    const partial = buildOpenAIResponseData(acc, model)
    const truncErr = new Error("Upstream stream truncated before completion (no finish_reason)")
    consola.error(`[ChatCompletions:v4] Upstream truncated for ${acc.model || model}: drained without a finish_reason`)
    await sink.writeSynthetic?.(openAIStreamErrorFrame(truncErr)).catch(() => undefined)
    recordForwarded()
    env.ctx.fail(acc.model || model, truncErr, { usage: partial.usage, content: partial.content })
    return
  }
  await sink.write({ data: "[DONE]" })
  recordForwarded()
  env.ctx.complete(buildOpenAIResponseData(acc, model))
}
