import type { Context } from "hono"

import consola from "consola"
import pc from "picocolors"

import type { LightweightModelOperation } from "~/lib/context/lightweight-model-operation"
import type { MessagesPayload } from "~/types/api/anthropic"

import {
  //
  postAnthropicUpstream,
  prepareAnthropicRequest,
} from "~/lib/anthropic/client"
import { runAnthropicPayloadRewrites } from "~/lib/anthropic/payload-rewrites"
import { countTotalInputTokens } from "~/lib/anthropic/token-counting"
import { createLightweightModelOperation } from "~/lib/context/lightweight-model-operation"
import { createResponseHeaderTimeoutSignal } from "~/lib/fetch-utils"
import { calibrate } from "~/lib/models/calibration"
import {
  //
  ENDPOINT,
  isEndpointSupported,
} from "~/lib/models/endpoint"
import { resolveModelName } from "~/lib/models/resolver"
import {
  //
  formatDuration,
  formatTime,
} from "~/lib/observability/projections/format"
import { publishRequestLine } from "~/lib/observability/synthetic-request-line"
import { state } from "~/lib/state"

function parseEnvelope(text: string): unknown {
  if (text.length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Forward one prepared count request to GHC while retaining the complete attempt. */
async function countTokensViaGhc(
  c: Context,
  payload: MessagesPayload,
  selectedModel: NonNullable<ReturnType<typeof state.modelIndex.get>>,
  operation: LightweightModelOperation,
): Promise<number | null> {
  const clientAnthropicBeta = c.req.raw.headers.get("anthropic-beta") ?? undefined
  const clientRequestHeaders = Object.fromEntries(c.req.raw.headers.entries())
  const { wire, headers } = prepareAnthropicRequest(payload, {
    resolvedModel: selectedModel,
    clientAnthropicBeta,
    clientRequestHeaders,
  })
  const outboundModel = typeof wire.model === "string" ? wire.model : payload.model
  const attempt = operation.beginAttempt({
    source: "upstream",
    effectiveRequest: payload,
    wireRequest: wire,
    wireHeaders: new Headers(headers),
    upstreamEndpoint: "/v1/messages/count_tokens",
  })

  try {
    const response = await postAnthropicUpstream({
      path: "/v1/messages/count_tokens",
      wire,
      headers,
      model: outboundModel,
      signal: createResponseHeaderTimeoutSignal(outboundModel),
    })
    const responseText = await response.text()
    const envelope = parseEnvelope(responseText)

    if (!response.ok) {
      const error = Object.assign(new Error(`GHC count_tokens returned HTTP ${response.status}`), {
        status: response.status,
        responseText,
      })
      attempt.discard({
        result: envelope,
        status: response.status,
        headers: response.headers,
        error,
        reason: "falling back to local token count",
      })
      consola.warn(`[count_tokens] GHC upstream failed: ${response.status} ${responseText} — falling back to local estimation`)
      return null
    }

    const inputTokens = typeof envelope === "object" && envelope !== null ? (envelope as { input_tokens?: unknown }).input_tokens : undefined
    if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens)) {
      const error = Object.assign(new Error("GHC count_tokens response omitted a finite input_tokens value"), {
        status: response.status,
        responseText,
      })
      attempt.discard({ result: envelope, status: response.status, headers: response.headers, error, reason: "invalid upstream count envelope" })
      consola.warn("[count_tokens] GHC upstream returned an invalid count envelope — falling back to local estimation")
      return null
    }

    attempt.commit({
      result: envelope,
      status: response.status,
      headers: response.headers,
      usage: { inputTokens, details: { response: envelope } },
      metadata: { rawCount: inputTokens, calibratedCount: inputTokens, source: "upstream" },
    })
    return inputTokens
  } catch (error) {
    attempt.discard({ error, reason: "falling back to local token count" })
    consola.warn("[count_tokens] GHC upstream error — falling back to local estimation:", error)
    return null
  }
}

/** Anthropic-compatible token counting with a standalone History V3 operation. */
export async function handleCountTokens(c: Context) {
  const startTime = Date.now()
  const method = c.req.method
  const reqPath = c.req.path
  let operation: LightweightModelOperation | undefined
  let routingRecorded = false
  let workingPayload: MessagesPayload | undefined

  const emitLine = (model: string, inputTokens: number, channel: string): void => {
    const durationMs = Date.now() - startTime
    publishRequestLine({
      prefix: "[ OK ]",
      time: formatTime(),
      method,
      path: reqPath,
      model,
      status: 200,
      duration: formatDuration(durationMs),
      durationMs,
      inputTokens,
      extra: pc.dim(` (${channel})`),
    })
  }

  try {
    const parsedPayload = await c.req.json<MessagesPayload>()
    const semanticInput = structuredClone(parsedPayload)
    workingPayload = { ...parsedPayload, model: resolveModelName(parsedPayload.model) }
    operation = createLightweightModelOperation({
      kind: "count_tokens",
      request: c.req.raw,
      semanticRequest: semanticInput,
      format: "anthropic-messages",
      requestedModel: parsedPayload.model,
      metadata: { source: "anthropic", requestedModel: parsedPayload.model },
    })

    const selectedModel = state.modelIndex.get(workingPayload.model)
    let payload = workingPayload
    try {
      payload = runAnthropicPayloadRewrites(workingPayload, { toolNameMapper: null }).payload
    } catch (error) {
      consola.warn("[count_tokens] payload sanitize failed — counting the raw payload:", error)
    }

    const canUseUpstream = Boolean(state.useUpstreamCountTokens && selectedModel && isEndpointSupported(selectedModel, ENDPOINT.MESSAGES))
    operation.recordRouting({
      resolvedModel: selectedModel?.id ?? payload.model,
      source: canUseUpstream ? "upstream" : "local",
      ...(canUseUpstream && { upstreamProtocol: "anthropic", upstreamEndpoint: "/v1/messages/count_tokens" }),
      metadata: { preferredSource: canUseUpstream ? "upstream" : "local", fallbackSource: canUseUpstream ? "local" : undefined },
    })
    routingRecorded = true

    if (!selectedModel) {
      const attempt = operation.beginAttempt({ source: "local", effectiveRequest: payload, wireRequest: { payload, tokenizer: null } })
      attempt.commit({
        result: { input_tokens: 1 },
        usage: { inputTokens: 1 },
        metadata: { rawCount: 1, calibratedCount: 1, source: "local", reason: "unknown-model" },
      })
      const response = c.json({ input_tokens: 1 })
      await operation.complete(response, { usage: { inputTokens: 1 }, metadata: { countTokens: { rawCount: 1, calibratedCount: 1, source: "local" } } })
      emitLine(payload.model, 1, "unknown model")
      return response
    }

    if (canUseUpstream) {
      const ghcCount = await countTokensViaGhc(c, payload, selectedModel, operation)
      if (ghcCount !== null) {
        const response = c.json({ input_tokens: ghcCount })
        await operation.complete(response, {
          usage: { inputTokens: ghcCount },
          metadata: { countTokens: { rawCount: ghcCount, calibratedCount: ghcCount, source: "upstream" } },
        })
        emitLine(payload.model, ghcCount, "GHC upstream")
        return response
      }
    }

    const rawEstimate = await countTotalInputTokens(payload, selectedModel)
    const inputTokens = calibrate(selectedModel.id, rawEstimate)
    const tokenizer = selectedModel.capabilities?.tokenizer ?? "o200k_base"
    const attempt = operation.beginAttempt({ source: "local", effectiveRequest: payload, wireRequest: { payload, tokenizer } })
    attempt.commit({
      result: { input_tokens: inputTokens, rawCount: rawEstimate, calibratedCount: inputTokens, source: "local" },
      usage: { inputTokens, details: { rawCount: rawEstimate, calibratedCount: inputTokens } },
      metadata: { rawCount: rawEstimate, calibratedCount: inputTokens, source: "local", tokenizer },
    })
    const response = c.json({ input_tokens: inputTokens })
    await operation.complete(response, {
      usage: { inputTokens, details: { rawCount: rawEstimate, calibratedCount: inputTokens } },
      metadata: { countTokens: { rawCount: rawEstimate, calibratedCount: inputTokens, source: "local" } },
    })
    emitLine(payload.model, inputTokens, `local calibrated, ${tokenizer}`)
    return response
  } catch (error) {
    consola.error("[count_tokens] Error counting tokens:", error)
    const response = c.json({ input_tokens: 1 })
    if (operation !== undefined) {
      if (!routingRecorded) operation.recordRouting({ resolvedModel: workingPayload?.model, source: "local", metadata: { failedBeforeRouting: true } })
      const attempt = operation.beginAttempt({ source: "local", effectiveRequest: workingPayload, wireRequest: { payload: workingPayload } })
      attempt.fail({ error, reason: "count_tokens handler failure" })
      await operation.fail(response, error, { usage: { inputTokens: 1 }, metadata: { countTokens: { rawCount: 1, calibratedCount: 1, source: "local" } } })
    }
    return response
  }
}
