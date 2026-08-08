import type { Context } from "hono"

import { Hono } from "hono"

import type { HistoryReservation } from "~/lib/history/worker/admission"

import { createLightweightModelOperation } from "~/lib/context/lightweight-model-operation"
import {
  //
  forwardError,
  HTTPError,
  isAbortError,
} from "~/lib/error"
import { withHistoryAdmission } from "~/lib/history/worker/http-admission"
import { resolveModelName } from "~/lib/models/resolver"
import {
  //
  executeEmbeddingsRequest,
  type EmbeddingRequest,
  prepareEmbeddingsRequest,
} from "~/lib/openai/embeddings"

export const embeddingsRoutes = new Hono()

function embeddingInputShape(input: EmbeddingRequest["input"]): Readonly<Record<string, unknown>> {
  const values = typeof input === "string" ? [input] : input
  return {
    kind: typeof input === "string" ? "string" : "array",
    count: values.length,
    lengths: values.map((value) => value.length),
  }
}

function parseResponseText(text: string): unknown {
  if (text.length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Handle every OpenAI/Azure-compatible embeddings entry through one operation. */
export async function handleEmbeddings(c: Context) {
  return await withHistoryAdmission(c.req.raw, "embeddings", async (historyReservation) => await handleEmbeddingsAdmitted(c, historyReservation))
}

async function handleEmbeddingsAdmitted(c: Context, historyReservation: HistoryReservation) {
  const parsedPayload = (c.get("injectedPayload") as EmbeddingRequest | undefined) ?? (await c.req.json<EmbeddingRequest>())
  const semanticInput = structuredClone(parsedPayload)
  const azureModelOverride = c.get("azureModelOverride") as string | undefined
  const effectiveModel = resolveModelName(azureModelOverride ?? parsedPayload.model)
  const effectivePayload: EmbeddingRequest = { ...parsedPayload, model: effectiveModel }
  const operation = createLightweightModelOperation({
    kind: "embeddings",
    request: c.req.raw,
    semanticRequest: semanticInput,
    format: "openai-embeddings",
    requestedModel: parsedPayload.model,
    historyReservation,
    metadata: {
      source: azureModelOverride === undefined ? "openai-compatible" : "azure-openai",
      inputShape: embeddingInputShape(parsedPayload.input),
      ...(azureModelOverride === undefined ? {} : { azure: { deployment: azureModelOverride, path: c.req.path } }),
    },
  })
  operation.recordRouting({
    resolvedModel: effectiveModel,
    source: "upstream",
    upstreamProtocol: "openai-embeddings",
    upstreamEndpoint: "/embeddings",
    metadata: azureModelOverride === undefined ? undefined : { azureDeployment: azureModelOverride },
  })

  let attempt: ReturnType<typeof operation.beginAttempt> | undefined
  try {
    const prepared = prepareEmbeddingsRequest(effectivePayload)
    attempt = operation.beginAttempt({
      source: "upstream",
      effectiveRequest: effectivePayload,
      wireRequest: prepared.payload,
      wireHeaders: new Headers(prepared.headers),
      upstreamEndpoint: "/embeddings",
      metadata: { inputShape: embeddingInputShape(prepared.payload.input) },
    })
    const exchange = await executeEmbeddingsRequest(prepared)
    const usage = {
      inputTokens: exchange.body.usage.prompt_tokens,
      outputTokens: 0,
      details: exchange.body.usage,
    }
    attempt.commit({
      result: exchange.body,
      status: exchange.status,
      headers: exchange.headers,
      usage,
      metadata: { usage: exchange.body.usage },
    })
    const response = c.json(exchange.body)
    await operation.complete(response, { usage, metadata: { source: "upstream", inputShape: embeddingInputShape(parsedPayload.input) } })
    return response
  } catch (error) {
    if (attempt === undefined) {
      attempt = operation.beginAttempt({
        source: "upstream",
        effectiveRequest: effectivePayload,
        wireRequest: effectivePayload,
        upstreamEndpoint: "/embeddings",
        metadata: { preparationFailed: true, inputShape: embeddingInputShape(parsedPayload.input) },
      })
    }
    const upstreamResult = error instanceof HTTPError ? parseResponseText(error.responseText) : undefined
    attempt.fail({
      ...(upstreamResult === undefined ? {} : { result: upstreamResult }),
      ...(error instanceof HTTPError ? { status: error.status, headers: error.responseHeaders } : {}),
      error,
      reason: "embeddings exchange failed",
    })
    const response = forwardError(c, error, "openai")
    const terminalInput = { metadata: { source: "upstream", inputShape: embeddingInputShape(parsedPayload.input) } }
    await (error instanceof Error && isAbortError(error) ? operation.abort(response, error, terminalInput) : operation.fail(response, error, terminalInput))
    return response
  }
}

embeddingsRoutes.post("/", async (c) => {
  try {
    return await handleEmbeddings(c)
  } catch (error) {
    return forwardError(c, error, "openai")
  }
})
