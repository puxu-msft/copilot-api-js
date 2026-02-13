import type { Context } from "hono"

import consola from "consola"
import type { ServerSentEventMessage } from "fetch-event-stream"
import { SSEStreamingApi, streamSSE } from "hono/streaming"

import type { Model } from "~/services/copilot/get-models"

import { executeWithAdaptiveRateLimit } from "~/lib/adaptive-rate-limiter"
import { awaitApproval } from "~/lib/approval"
import { MAX_AUTO_TRUNCATE_RETRIES } from "~/lib/auto-truncate/common"
import {
  autoTruncateOpenAI,
  createTruncationResponseMarkerOpenAI,
} from "~/lib/auto-truncate/openai"
import { sanitizeOpenAIMessages } from "~/lib/openai/sanitize"
import { type MessageContent, recordRequest } from "~/lib/history"
import { translateModelName } from "~/lib/models/resolver"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import { processOpenAIMessages } from "~/lib/system-prompt-manager"
import { tuiLogger } from "~/lib/tui"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import {
  createOpenAIStreamAccumulator,
  accumulateOpenAIStreamEvent,
} from "~/lib/openai/stream-accumulator"

import type { FormatAdapter } from "../shared/pipeline"

import {
  type ResponseContext,
  extractErrorContent,
  finalizeRequest,
  isNonStreaming,
  logPayloadSizeInfo,
  updateTrackerStatus,
} from "../shared"
import { executeRequestPipeline } from "../shared/pipeline"
import { buildOpenAIStreamResult } from "../shared/recording"
import { createAutoTruncateStrategy, type TruncateResult } from "../shared/strategies/auto-truncate"

export async function handleCompletion(c: Context) {
  const originalPayload = await c.req.json<ChatCompletionsPayload>()

  // Resolve model name aliases and date-suffixed versions
  const resolvedModel = translateModelName(originalPayload.model)
  if (resolvedModel !== originalPayload.model) {
    consola.debug(`Model name resolved: ${originalPayload.model} → ${resolvedModel}`)
    originalPayload.model = resolvedModel
  }

  // Find the selected model and validate endpoint support before recording
  const selectedModel = state.models?.data.find((model) => model.id === originalPayload.model)
  if (selectedModel?.supported_endpoints && !selectedModel.supported_endpoints.includes("/chat/completions")) {
    return c.json(
      {
        error: {
          message:
            `Model '${originalPayload.model}' does not support the /chat/completions endpoint. `
            + `Supported endpoints: ${selectedModel.supported_endpoints.join(", ")}`,
          type: "invalid_request_error",
          param: "model",
          code: "model_not_supported",
        },
      },
      400,
    )
  }

  // System prompt collection + config-based overrides (always active)
  originalPayload.messages = await processOpenAIMessages(originalPayload.messages)

  // Record request to history with full messages
  const historyId = recordRequest("openai", {
    model: originalPayload.model,
    messages: originalPayload.messages as unknown as MessageContent[],
    stream: originalPayload.stream ?? false,
    tools: originalPayload.tools?.map((t) => ({
      name: t.function.name,
      description: t.function.description,
    })),
    max_tokens: originalPayload.max_tokens ?? undefined,
    temperature: originalPayload.temperature ?? undefined,
  })

  // Get tracking ID and use tracker's startTime for consistent timing
  const tuiLogId = c.get("tuiLogId") as string | undefined

  // Update TUI tracker with model info
  if (tuiLogId) tuiLogger.updateRequest(tuiLogId, { model: originalPayload.model })

  const trackedRequest = tuiLogId ? tuiLogger.getRequest(tuiLogId) : undefined
  const startTime = trackedRequest?.startTime ?? Date.now()
  const ctx: ResponseContext = { historyId, tuiLogId, startTime }

  // Sanitize messages (filter orphaned tool blocks, system-reminders)
  const { payload: sanitizedPayload } = sanitizeOpenAIMessages(originalPayload)

  const finalPayload =
    isNullish(sanitizedPayload.max_tokens) ?
      {
        ...sanitizedPayload,
        max_tokens: selectedModel?.capabilities?.limits?.max_output_tokens,
      }
    : sanitizedPayload

  if (isNullish(originalPayload.max_tokens)) {
    consola.debug("Set max_tokens to:", JSON.stringify(finalPayload.max_tokens))
  }

  if (state.manualApprove) await awaitApproval()

  // Execute request with reactive retry pipeline
  return executeRequest({
    c,
    payload: finalPayload,
    originalPayload,
    selectedModel,
    ctx,
    tuiLogId,
  })
}

/** Options for executeRequest */
interface ExecuteRequestOptions {
  c: Context
  payload: ChatCompletionsPayload
  originalPayload: ChatCompletionsPayload
  selectedModel: Model | undefined
  ctx: ResponseContext
  tuiLogId: string | undefined
}

/**
 * Execute the API call with reactive retry pipeline.
 * Handles 413 and token limit errors with auto-truncation.
 */
async function executeRequest(opts: ExecuteRequestOptions) {
  const { c, payload, originalPayload, selectedModel, ctx, tuiLogId } = opts

  // Build adapter and strategy for the pipeline
  const adapter: FormatAdapter<ChatCompletionsPayload> = {
    format: "openai",
    sanitize: (p) => sanitizeOpenAIMessages(p),
    execute: (p) => executeWithAdaptiveRateLimit(() => createChatCompletions(p)),
    logPayloadSize: (p) => logPayloadSizeInfo(p, selectedModel),
  }

  const strategies = [
    createAutoTruncateStrategy<ChatCompletionsPayload>({
      truncate: (p, model, truncOpts) =>
        autoTruncateOpenAI(p, model, truncOpts) as Promise<TruncateResult<ChatCompletionsPayload>>,
      resanitize: (p) => sanitizeOpenAIMessages(p),
      isEnabled: () => state.autoTruncate,
      label: "Completions",
    }),
  ]

  try {
    const result = await executeRequestPipeline({
      adapter,
      strategies,
      payload,
      originalPayload,
      model: selectedModel,
      maxRetries: MAX_AUTO_TRUNCATE_RETRIES,
      onRetry: (attempt, _strategyName, _newPayload, meta) => {
        // Capture truncation result for response marker
        const retryTruncateResult = meta?.truncateResult as ResponseContext["truncateResult"]
        if (retryTruncateResult) {
          ctx.truncateResult = retryTruncateResult
        }

        // Update tracking tags
        if (tuiLogId) {
          tuiLogger.updateRequest(tuiLogId, { tags: ["truncated", `retry-${attempt + 1}`] })
        }
      },
    })

    ctx.queueWaitMs = result.queueWaitMs
    const response = result.response

    if (isNonStreaming(response as ChatCompletionResponse | AsyncIterable<unknown>)) {
      return handleNonStreamingResponse(c, response as ChatCompletionResponse, ctx)
    }

    consola.debug("Streaming response")
    updateTrackerStatus(tuiLogId, "streaming")

    return streamSSE(c, async (stream) => {
      await handleStreamingResponse({
        stream,
        response: response as AsyncIterable<ServerSentEventMessage>,
        payload,
        ctx,
      })
    })
  } catch (error) {
    finalizeRequest(ctx, {
      success: false,
      model: payload.model,
      usage: { input_tokens: 0, output_tokens: 0 },
      error: error instanceof Error ? error.message : String(error),
      content: extractErrorContent(error),
      durationMs: Date.now() - ctx.startTime,
    })
    throw error
  }
}

// Handle non-streaming response
function handleNonStreamingResponse(c: Context, originalResponse: ChatCompletionResponse, ctx: ResponseContext) {
  // Prepend truncation marker if auto-truncate was performed (only in verbose mode)
  let response = originalResponse
  if (state.verbose && ctx.truncateResult?.wasTruncated && response.choices[0]?.message.content) {
    const marker = createTruncationResponseMarkerOpenAI(ctx.truncateResult)
    response = {
      ...response,
      choices: response.choices.map((choice, i) =>
        i === 0 ?
          {
            ...choice,
            message: {
              ...choice.message,
              content: marker + choice.message.content,
            },
          }
        : choice,
      ),
    }
  }

  const choice = response.choices[0]
  const usage = response.usage

  finalizeRequest(ctx, {
    success: true,
    model: response.model,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      ...(usage?.prompt_tokens_details?.cached_tokens !== undefined && {
        cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens,
      }),
    },
    stop_reason: choice.finish_reason ?? undefined,
    content: choice.message,
    durationMs: Date.now() - ctx.startTime,
    queueWaitMs: ctx.queueWaitMs,
  })

  return c.json(response)
}

/** Options for handleStreamingResponse */
interface StreamingOptions {
  stream: SSEStreamingApi
  response: AsyncIterable<ServerSentEventMessage>
  payload: ChatCompletionsPayload
  ctx: ResponseContext
}

// Handle streaming response
async function handleStreamingResponse(opts: StreamingOptions) {
  const { stream, response, payload, ctx } = opts
  const acc = createOpenAIStreamAccumulator()

  try {
    // Prepend truncation marker as first chunk if auto-truncate was performed (only in verbose mode)
    if (state.verbose && ctx.truncateResult?.wasTruncated) {
      const marker = createTruncationResponseMarkerOpenAI(ctx.truncateResult)
      const markerChunk: ChatCompletionChunk = {
        id: `truncation-marker-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: payload.model,
        choices: [
          {
            index: 0,
            delta: { content: marker },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }
      await stream.writeSSE({
        data: JSON.stringify(markerChunk),
        event: "message",
      })
      acc.content += marker
    }

    for await (const rawEvent of response) {
      // Check shutdown abort signal — break out of stream gracefully
      if (getShutdownSignal()?.aborted) break

      // Parse and accumulate for history/tracking (skip [DONE] and empty data)
      if (rawEvent.data && rawEvent.data !== "[DONE]") {
        try {
          const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
          accumulateOpenAIStreamEvent(chunk, acc)
        } catch {
          // Ignore parse errors
        }
      }

      // Forward every event to client — proxy preserves upstream data
      await stream.writeSSE({
        data: rawEvent.data ?? "",
        event: rawEvent.event,
        id: String(rawEvent.id),
        retry: rawEvent.retry,
      })
    }

    const result = buildOpenAIStreamResult(acc, payload.model, ctx)
    finalizeRequest(ctx, result)
  } catch (error) {
    finalizeRequest(ctx, {
      success: false,
      model: acc.model || payload.model,
      usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens },
      error: error instanceof Error ? error.message : String(error),
      content: acc.content ? { role: "assistant", content: acc.content } : null,
      durationMs: Date.now() - ctx.startTime,
    })
    throw error
  }
}
