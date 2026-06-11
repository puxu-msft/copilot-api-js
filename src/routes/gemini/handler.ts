/**
 * Google Gemini-compatible request handlers.
 *
 * Strategy: translate the inbound Gemini request to an internal OpenAI
 * ChatCompletionsPayload, run it through the shared chat-completion pipeline
 * (sanitize / auto-truncate / retry / history / rate-limit), then translate
 * the raw upstream response back into Gemini wire format.
 *
 * History recording captures the original Gemini payload AND the translated
 * OpenAI payload — see `setOriginalRequest({ payload: rawSnapshot, ... })`
 * and the wire-request bookkeeping driven by the pipeline adapter. This
 * gives the UI both layers when debugging cross-protocol issues.
 */

import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { RequestContext } from "~/lib/context/request"
import type {
  //
  MessageContent,
  SseEventRecord,
} from "~/lib/history"
import type { Model } from "~/lib/models/client"
import type {
  //
  Content as GeminiContent,
  CountTokensRequest,
  CountTokensResponse,
  GenerateContentRequest,
  GenerateContentResponse,
  Part as GeminiPart,
} from "~/types/api/gemini"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { getRequestContextManager } from "~/lib/context/manager"
import { HTTPError } from "~/lib/error"
import { captureInboundHeaders } from "~/lib/fetch-utils"
import {
  //
  convertGeminiRequestToOpenAI,
  convertOpenAIResponseToGemini,
  translateOpenAIStreamToGemini,
} from "~/lib/gemini"
import { getSessionIdFromHeaders } from "~/lib/history/store"
import { resolveModelName } from "~/lib/models/resolver"
import { countTextTokens } from "~/lib/models/tokenizer"
import { sanitizeOpenAIMessages } from "~/lib/openai/sanitize"
import { isNonStreaming } from "~/lib/request"
import { settleStreamingFailure } from "~/lib/request/stream-settle"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import {
  //
  type StreamErrorKind,
  classifyStreamError,
  guardSseIterable,
} from "~/lib/stream"
import { processOpenAIMessages } from "~/lib/system-prompt"
import { tuiLogger } from "~/lib/tui"
import { isNullish } from "~/lib/utils"
import {
  //
  type ChatCompletionRendererArgs,
  runChatCompletionPipeline,
} from "~/routes/chat-completions/handler"

const DROPPED_GEMINI_PARAMS_WARNING_CODE = "gemini_dropped_params"

/** POST /v1beta/models/:model:generateContent */
export async function handleGenerateContent(c: Context, modelId: string): Promise<Response> {
  const body = await c.req.json<GenerateContentRequest>()
  const reqCtx = await prepareGeminiRequest(c, body, modelId, { stream: false })
  const { payload, originalPayload, selectedModel } = reqCtx

  return runChatCompletionPipeline({
    c,
    payload,
    originalPayload,
    selectedModel,
    reqCtx: reqCtx.ctx,
    render: (args) => renderGeminiNonStreaming(args, modelId),
  })
}

/** POST /v1beta/models/:model:streamGenerateContent */
export async function handleStreamGenerateContent(c: Context, modelId: string): Promise<Response> {
  const body = await c.req.json<GenerateContentRequest>()
  const reqCtx = await prepareGeminiRequest(c, body, modelId, { stream: true })
  const { payload, originalPayload, selectedModel } = reqCtx

  return runChatCompletionPipeline({
    c,
    payload,
    originalPayload,
    selectedModel,
    reqCtx: reqCtx.ctx,
    render: (args) => renderGeminiStreaming(args, modelId),
  })
}

/**
 * POST /v1beta/models/:model:countTokens
 *
 * This project has no upstream `countTokens` API. We approximate input tokens
 * locally with the same `gpt-tokenizer` machinery used by the Anthropic
 * count-tokens handler. We collect text from `body.contents` (and
 * `body.systemInstruction` if present), replacing non-text parts with short
 * placeholders, then tokenize the concatenated string. Naively tokenizing
 * `JSON.stringify(body)` over-counts by 2–4× because braces / quotes / field
 * names like `"contents"`, `"parts"` would be tokenized too, which causes
 * real Gemini clients to display false "over quota" UI states.
 */
export async function handleCountTokens(c: Context, modelId: string): Promise<Response> {
  const body = await c.req.json<CountTokensRequest>()

  const resolved = resolveModelName(modelId)
  const model = state.modelIndex.get(resolved)
  if (!model) {
    throw new HTTPError(`Model "${modelId}" not found`, 404, `Model "${modelId}" not found`)
  }

  const text = collectCountTokensText(body)
  const totalTokens = await countTextTokens(text, model)

  const response: CountTokensResponse = {
    totalTokens,
    // Mirror agent-maestro: when client sends `cachedContent`, surface a
    // zero `cachedContentTokenCount` placeholder so clients that key on its
    // presence don't see an undefined field.
    ...(body.cachedContent ? { cachedContentTokenCount: 0 } : {}),
  }

  return c.json(response)
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Collect text from a Gemini `CountTokensRequest` for local tokenization.
 *
 * Walks every `Content` (from both `contents` and the optional
 * `generateContentRequest` wrapper, plus the optional `systemInstruction`)
 * and concatenates only the meaningful textual surface area:
 *
 * - `part.text` is included verbatim.
 * - `part.functionCall` / `part.functionResponse` are JSON-stringified so the
 *   token estimate accounts for their payload size but not for surrounding
 *   wire-protocol envelope keys.
 * - `inlineData` / `fileData` get short placeholder strings so we don't try
 *   to tokenize base64 binary payloads.
 *
 * We intentionally do NOT tokenize `JSON.stringify(body)` — that approach
 * over-counts by 2–4× because braces, quotes, and field names like
 * `"contents"` / `"parts"` get tokenized too, which surfaces in real Gemini
 * clients as false "over quota" UI states.
 */
function collectCountTokensText(body: CountTokensRequest): string {
  const fragments: Array<string> = []

  const visitContent = (content: GeminiContent | undefined): void => {
    if (!content?.parts) return
    for (const part of content.parts) {
      fragments.push(partToCountableText(part))
    }
  }

  visitContent(body.generateContentRequest?.systemInstruction)
  for (const content of body.generateContentRequest?.contents ?? []) {
    visitContent(content)
  }

  for (const content of body.contents ?? []) {
    visitContent(content)
  }

  return fragments.filter((s) => s.length > 0).join("\n")
}

function partToCountableText(part: GeminiPart): string {
  if (part.text !== undefined) return part.text
  if (part.functionCall) {
    return JSON.stringify({ name: part.functionCall.name, args: part.functionCall.args ?? {} })
  }
  if (part.functionResponse) {
    return JSON.stringify({ name: part.functionResponse.name, response: part.functionResponse.response ?? null })
  }
  if (part.inlineData) {
    const mime = part.inlineData.mimeType ?? "application/octet-stream"
    return `[inlineData:${mime}]`
  }
  if (part.fileData?.fileUri) {
    return `[fileData:${part.fileData.fileUri}]`
  }
  return ""
}

interface PreparedGeminiRequest {
  ctx: RequestContext
  payload: ChatCompletionsPayload
  originalPayload: ChatCompletionsPayload
  selectedModel: Model | undefined
}

/**
 * Translate a Gemini request body to the internal ChatCompletions payload and
 * register a `gemini-generate-content` request context. The returned bundle
 * is consumed by `runChatCompletionPipeline()`.
 */
async function prepareGeminiRequest(c: Context, body: GenerateContentRequest, modelId: string, opts: { stream: boolean }): Promise<PreparedGeminiRequest> {
  // Snapshot the inbound Gemini payload BEFORE any mutation so history sees
  // exactly what the client sent.
  const geminiSnapshot = structuredClone(body)

  // 1. Resolve model
  const resolvedModel = resolveModelName(modelId)
  if (resolvedModel !== modelId) {
    consola.debug(`[gemini] Model name resolved: ${modelId} → ${resolvedModel}`)
  }
  const selectedModel = state.modelIndex.get(resolvedModel)

  // 2. Translate Gemini → OpenAI
  const { payload: openaiPayload, droppedParams } = convertGeminiRequestToOpenAI(body, {
    model: resolvedModel,
    stream: opts.stream,
  })

  // 3. Apply project-level message processing (system-prompt overrides etc.)
  openaiPayload.messages = await processOpenAIMessages(openaiPayload.messages, openaiPayload.model)

  // 4. Create request context with the Gemini endpoint type. The original
  //    request payload field holds the raw Gemini snapshot — UI shows the
  //    client's actual input — while the wire-request side captures the
  //    translated OpenAI payload as the adapter sends each attempt.
  const tuiLogId = c.get("tuiLogId") as string | undefined
  const manager = getRequestContextManager()
  const ctx = manager.create({
    endpoint: "gemini-generate-content",
    sessionId: getSessionIdFromHeaders(c.req.raw.headers),
    tuiLogId,
    rawPath: c.req.path,
  })
  ctx.setOriginalRequest({
    model: modelId,
    // `messages` MUST reflect the original wire shape (Gemini contents),
    // mirroring how the Anthropic handler stores Anthropic-shape messages.
    // Storing translated OpenAI messages here would mix sources and mislead
    // the UI / debugging tools.
    messages: projectGeminiContentsAsMessages(geminiSnapshot.contents ?? [], geminiSnapshot.systemInstruction),
    stream: opts.stream,
    tools: body.tools?.flatMap((t) =>
      (t.functionDeclarations ?? []).map((f) => ({
        name: f.name ?? "",
        description: f.description,
      })),
    ),
    payload: geminiSnapshot,
  })
  ctx.setInboundRequestHeaders(captureInboundHeaders(c.req.raw.headers))

  // Record lossy translation as a warning so the UI surfaces what was dropped.
  if (droppedParams.length > 0) {
    const message = `Gemini → ChatCompletions translation dropped unsupported params: ${droppedParams.join(", ")}`
    consola.warn(`[gemini] model=${resolvedModel} ${message}`)
    ctx.addWarningMessage({ code: DROPPED_GEMINI_PARAMS_WARNING_CODE, message })
    if (tuiLogId) {
      tuiLogger.updateRequest(tuiLogId, { tags: ["dropped-params"] })
    }
  }

  if (tuiLogId) {
    tuiLogger.updateRequest(tuiLogId, {
      model: resolvedModel,
      ...(modelId !== resolvedModel && { clientModel: modelId }),
    })
  }

  // 5. Sanitize and auto-fill max_completion_tokens (mirrors handleChatCompletion)
  const { payload: sanitizedPayload } = sanitizeOpenAIMessages(openaiPayload)
  const hasMaxTokens = !isNullish(sanitizedPayload.max_tokens) || !isNullish(sanitizedPayload.max_completion_tokens)
  const payload =
    hasMaxTokens ? sanitizedPayload : (
      {
        ...sanitizedPayload,
        max_completion_tokens: selectedModel?.capabilities?.limits?.max_output_tokens,
      }
    )

  return { ctx, payload, originalPayload: openaiPayload, selectedModel }
}

/**
 * Project Gemini `Content[]` into the loosely-typed `MessageContent[]` shape
 * the history layer accepts. We preserve the Gemini structure (role + parts)
 * verbatim so the UI sees the same shape the client sent. Optional
 * `systemInstruction` is prepended as a synthetic role:"system" entry.
 */
function projectGeminiContentsAsMessages(contents: ReadonlyArray<GeminiContent>, systemInstruction: GeminiContent | undefined): Array<MessageContent> {
  const out: Array<MessageContent> = []
  if (systemInstruction) {
    out.push({ role: "system", content: systemInstruction.parts ?? [] } as unknown as MessageContent)
  }
  for (const content of contents) {
    out.push({
      role: content.role ?? "user",
      content: (content.parts ?? []) as ReadonlyArray<GeminiPart>,
    } as unknown as MessageContent)
  }
  return out
}

/** Non-streaming render: emit a single JSON GenerateContentResponse */
function renderGeminiNonStreaming(args: ChatCompletionRendererArgs, modelId: string): Response | Promise<Response> {
  const { c, response, reqCtx } = args
  if (!isNonStreaming(response)) {
    // Shouldn't happen — we set stream:false on the payload — but keep the
    // type-system honest with a runtime guard.
    throw new HTTPError("Expected non-streaming response", 500, "Internal: streaming response on non-stream path")
  }
  const chat = response
  const gemini: GenerateContentResponse = convertOpenAIResponseToGemini(chat, modelId)

  // Settle the request context with usage info derived from the upstream
  // response (mirrors handleNonStreamingResponse in chat-completions).
  const choice = chat.choices[0]
  const usage = chat.usage
  // The client receives the Gemini-translated response; complete() records the
  // upstream OpenAI-shape message for history.
  reqCtx.setForwardedResponse({ content: gemini })
  reqCtx.complete({
    success: true,
    model: chat.model,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      ...(usage?.prompt_tokens_details?.cached_tokens !== undefined && {
        cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens,
      }),
    },
    stop_reason: choice.finish_reason ?? undefined,
    content: choice.message,
  })

  return c.json(gemini)
}

/**
 * Streaming render: translate OpenAI SSE → Gemini SSE.
 *
 * Wraps the upstream iterator with `guardSseIterable` so each frame is raced
 * against the configured idle timeout and a combined abort signal (shutdown
 * + client disconnect). Mirrors `handleStreamingResponse` in chat-completions
 * so Gemini clients get the same liveness guarantees as OpenAI clients.
 */
/** Map a streaming error kind to the Gemini gRPC `status` string. Shutdown → retryable UNAVAILABLE. */
function geminiStreamErrorStatus(kind: StreamErrorKind): string {
  switch (kind) {
    case "idle-timeout": {
      return "DEADLINE_EXCEEDED"
    }
    case "shutdown": {
      return "UNAVAILABLE"
    }
    default: {
      return "INTERNAL"
    }
  }
}

function renderGeminiStreaming(args: ChatCompletionRendererArgs, modelId: string): Response {
  const { c, response, payload, reqCtx } = args
  if (isNonStreaming(response)) {
    throw new HTTPError("Expected streaming response", 500, "Internal: non-streaming response on stream path")
  }

  reqCtx.transition("streaming")

  return streamSSE(c, async (stream) => {
    const clientAbort = new AbortController()
    stream.onAbort(() => clientAbort.abort())

    const idleTimeoutMs = state.streamIdleTimeout * 1000
    let usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } = {}
    let finishReason: string | undefined
    // Forwarded frames — the Gemini-translated SSE the client actually received.
    const forwardedSseEvents: Array<SseEventRecord> = []
    const streamStartMs = Date.now()

    try {
      // Wrap the upstream SSE iterable with an abort/idle-timeout-aware adapter
      // so the translator's `for await` cannot block indefinitely. The shutdown
      // signal is stable (process-global), so even a `.next()` already blocked on
      // a stalled upstream when shutdown begins observes the Phase 3 abort.
      const guarded = guardSseIterable(response, {
        idleTimeoutMs,
        shutdownSignal: getShutdownSignal(),
        clientSignal: clientAbort.signal,
      })

      for await (const step of translateOpenAIStreamToGemini(guarded, modelId)) {
        const frameData = step.frame.data ?? ""
        forwardedSseEvents.push({ offsetMs: Date.now() - streamStartMs, type: "generateContent", raw: frameData })
        await stream.writeSSE({ data: frameData })
        if (step.meta?.usageMetadata) {
          usageMetadata = step.meta.usageMetadata
        }
        if (step.meta?.finishReason) {
          finishReason = step.meta.finishReason
        }
      }

      reqCtx.setForwardedResponse({ sseEvents: forwardedSseEvents })
      reqCtx.complete({
        success: true,
        model: payload.model,
        usage: {
          input_tokens: usageMetadata.promptTokenCount ?? 0,
          output_tokens: usageMetadata.candidatesTokenCount ?? 0,
          ...(usageMetadata.cachedContentTokenCount !== undefined && {
            cache_read_input_tokens: usageMetadata.cachedContentTokenCount,
          }),
        },
        stop_reason: finishReason,
        content: null,
      })
    } catch (error) {
      // Preserve whatever partial usage / finishReason we accumulated before
      // the failure so the history layer doesn't show all-zero diagnostics
      // for a partially-streamed request.
      reqCtx.setForwardedResponse({ sseEvents: forwardedSseEvents })
      const partial = {
        usage: {
          input_tokens: usageMetadata.promptTokenCount ?? 0,
          output_tokens: usageMetadata.candidatesTokenCount ?? 0,
          ...(usageMetadata.cachedContentTokenCount !== undefined && {
            cache_read_input_tokens: usageMetadata.cachedContentTokenCount,
          }),
        },
        ...(finishReason !== undefined && { stop_reason: finishReason }),
      }
      // Uniform terminal settle: client disconnect → `aborted` (return, no
      // frame); else → `fail()` and emit the Gemini-shape error frame.
      if (settleStreamingFailure({ reqCtx, error, model: payload.model, partial })) {
        consola.debug("[gemini] Client disconnected mid-stream — recording aborted")
        return
      }
      consola.error("[gemini] Stream error:", error)
      // Emit a Gemini-shape data-only frame. Real Gemini SDK clients parse
      // every `data:` frame into `GenerateContentResponse`; named events
      // (`event: error`) are silently dropped by SDK consumers.
      const message = error instanceof Error ? error.message : String(error)
      const errorKind = classifyStreamError(error)
      // Shutdown → retryable UNAVAILABLE/503 so the client backs off and retries.
      const errorCode = errorKind === "shutdown" ? 503 : 500
      const errorStatus = geminiStreamErrorStatus(errorKind)
      await stream.writeSSE({
        data: JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text: message }] },
              finishReason: "OTHER",
              index: 0,
            },
          ],
          // Sidecar — keeps machine-readable diagnostics next to the SDK-
          // visible candidate so clients that DO inspect the raw envelope
          // can still surface status + http code.
          error: {
            code: errorCode,
            message,
            status: errorStatus,
          },
        }),
      })
    }
  })
}
