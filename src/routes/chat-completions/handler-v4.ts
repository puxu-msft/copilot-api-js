/**
 * v4 driver path for Chat Completions (P2.3).
 *
 * The Chat Completions route dispatches here (the v4 driver path — the only path
 * since P3.3 removed the legacy `handleChatCompletion`). Builds a
 * per-request driver (codec + HTTP transport + env strategies) and drives the
 * seven stages, keeping behavior equivalent to the legacy handler.
 *
 * P2-era division of labor (sampling sinks to the driver in P3.2): this route
 * still owns the response-side sampling (forwarded SSE events + accumulate +
 * complete/fail) and the client-facing finishing the codec does NOT do —
 * tool-name restore, the verbose truncation marker, and the via-responses
 * trailing `[DONE]` (P2.2-D2). The error frame is built inline (raw upstream
 * message) rather than via `codec.formatError` (P2.2-D4 — formatError only gets
 * the classified kind; the consumer has the raw error, so it matches legacy).
 */

import type { ServerSentEventMessage } from "fetch-event-stream"
import type { Context } from "hono"
import type { SSEStreamingApi } from "hono/streaming"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { HeadersCapture } from "~/lib/context/request"
import type { SseEventRecord } from "~/lib/history"
import type { Model } from "~/lib/models/client"
import type { OpenAIAutoTruncateResult } from "~/lib/openai/auto-truncate"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
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
import { HTTPError } from "~/lib/error"
import { ENDPOINT } from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import {
  //
  createTruncationResponseMarkerOpenAI,
} from "~/lib/openai/auto-truncate"
import {
  //
  accumulateOpenAIStreamEvent,
  createOpenAIStreamAccumulator,
} from "~/lib/openai/stream-accumulator"
import { streamErrorToOpenAIErrorType } from "~/lib/openai/stream-error"
import {
  //
  restoreChatCompletionsChunkToolNames,
  restoreChatCompletionsToolNames,
} from "~/lib/openai/tool-name-sanitize"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { buildOpenAIResponseData } from "~/lib/request"
import { settleStreamingFailure } from "~/lib/request/stream-settle"
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
  const resolvedName = resolveModelName(azureModelOverride ?? clientRaw.model)
  const selectedModel = state.modelIndex.get(resolvedName)
  const wireMessages = await processOpenAIMessages(clientRaw.messages, resolvedName)
  const wireBody: ChatCompletionsPayload = { ...clientRaw, messages: wireMessages }

  const clientAbort = new AbortController()
  const detachClientAbort = bridgeClientAbort(c, clientAbort)
  const headersCapture: HeadersCapture = {}
  const codec = createOpenAiCcCodec()
  const transport = createUpstreamHttpTransport({ headersCapture, clientAbortSignal: clientAbort.signal, idleTimeoutMs: state.streamIdleTimeout * 1000 })

  // Truncation result for the response marker (captured from the strategy factory).
  let truncateResult: OpenAIAutoTruncateResult | undefined

  const driver = createPipelineDriver({
    codec,
    transport,
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
      preResolved: { name: resolvedName, model: selectedModel },
      ...(azureModelOverride !== undefined && { modelOverride: azureModelOverride }),
      clientAbortSignal: clientAbort.signal,
    })
  } catch (error) {
    // Any failure after parse created the ctx (parse-period sanitize/translate
    // throw, or an exchange failure). Settle it (matching legacy's catch:
    // setHttpHeaders + fail) — `codec.getContext()` reaches the ctx even when the
    // throw happened before the envelope was otherwise capturable.
    const ctx = codec.getContext()
    if (ctx) {
      c.set("requestContext", ctx)
      ctx.setHttpHeaders(headersCapture)
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
  env.ctx.setHttpHeaders(headersCapture)

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

  const choice = response.choices[0]
  const usage = response.usage

  // Restore tool_call names (upstream → original) on the client-facing response.
  const clientResponse = restoreChatCompletionsToolNames(response, env.ctx.toolNameMapper)

  env.ctx.setForwardedResponse({ content: clientResponse.choices[0]?.message })
  env.ctx.complete({
    success: true,
    model: response.model,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      ...(usage?.prompt_tokens_details?.cached_tokens !== undefined && { cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens }),
    },
    stop_reason: choice.finish_reason ?? undefined,
    content: choice.message,
  })

  return c.json(clientResponse)
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

async function pumpStreamingV4(opts: PumpStreamingV4Options): Promise<void> {
  const { stream, driver, upstream, env } = opts
  const acc = createOpenAIStreamAccumulator()
  const mapper = env.ctx.toolNameMapper
  const viaResponses = env.targetEndpoint === ENDPOINT.RESPONSES
  const model = (env.body as ChatCompletionsPayload).model

  const forwardedSseEvents: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  let bytesIn = 0
  let eventsIn = 0

  try {
    // Verbose truncation marker as the first forwarded chunk.
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
      await stream.writeSSE({ data: JSON.stringify(markerChunk), event: "message" })
      forwardedSseEvents.push({ offsetMs: Date.now() - streamStartMs, type: "message", raw: JSON.stringify(markerChunk) })
      acc.rawContent += marker
    }

    for await (const frame of driver.runResponse(upstream, env)) {
      bytesIn += frame.data?.length ?? 0
      eventsIn++
      env.ctx.recordStreamProgress({ bytesIn, eventsIn })

      // Accumulate for history/tracking (upstream names; skip [DONE]/empty).
      if (frame.data && frame.data !== "[DONE]") {
        try {
          accumulateOpenAIStreamEvent(JSON.parse(frame.data) as ChatCompletionChunk, acc)
        } catch (err) {
          consola.debug(`[ChatCompletions:v4] skipping unparseable SSE frame (${err instanceof Error ? err.message : String(err)}):`, frame.data.slice(0, 200))
        }
      }

      // Forward with tool-call names restored (upstream → original). Preserve
      // id/retry when the upstream frame carried them (passthrough path).
      const sse = frame as ServerSentEventMessage
      const forwardData = restoreStreamToolNames(frame.data, mapper)
      forwardedSseEvents.push({ offsetMs: Date.now() - streamStartMs, type: frame.event ?? "message", raw: forwardData })
      await stream.writeSSE({
        data: forwardData,
        event: frame.event,
        id: sse.id !== undefined ? String(sse.id) : undefined,
        retry: sse.retry,
      })
    }

    // P2.2-D2: synthesize the via-responses trailing [DONE] (the per-frame codec
    // render never emits it; passthrough gets [DONE] from the upstream frames).
    if (viaResponses) {
      forwardedSseEvents.push({ offsetMs: Date.now() - streamStartMs, type: "message", raw: "[DONE]" })
      await stream.writeSSE({ data: "[DONE]" })
    }

    const responseData = buildOpenAIResponseData(acc, model)
    env.ctx.setForwardedResponse({ sseEvents: forwardedSseEvents })
    env.ctx.complete(responseData)
  } catch (error) {
    env.ctx.setForwardedResponse({ sseEvents: forwardedSseEvents })
    const partial = { usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens } }
    if (settleStreamingFailure({ reqCtx: env.ctx, error, model: acc.model || model, partial })) {
      consola.debug("[ChatCompletions:v4] Client disconnected mid-stream — recording aborted")
      return
    }
    consola.error("[ChatCompletions:v4] Stream error:", error)
    await stream.writeSSE({
      data: JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: streamErrorToOpenAIErrorType(error) } }),
      event: "error",
    })
  }
}
