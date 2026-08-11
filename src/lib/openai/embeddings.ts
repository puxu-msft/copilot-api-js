import {
  //
  copilotBaseUrl,
  copilotHeaders,
} from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { resolveResponseHeaderTimeoutMs } from "~/lib/models/timeout-resolver"
import { state } from "~/lib/state"
import { getTokenCredentials } from "~/lib/token"
import { upstreamFetch } from "~/lib/transport/upstream-fetch"

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
  encoding_format?: "float" | "base64"
  dimensions?: number
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}

export interface PreparedEmbeddingsRequest {
  readonly url: string
  readonly payload: EmbeddingRequest & { input: Array<string> }
  readonly headers: Record<string, string>
  readonly signal: AbortSignal | undefined
  readonly responseHeaderTimeoutMs: number
}

export interface EmbeddingsExchange {
  readonly body: EmbeddingResponse
  readonly status: number
  readonly headers: Headers
}

/** Freeze the exact request shape used at the transport boundary before I/O starts. */
export function prepareEmbeddingsRequest(payload: EmbeddingRequest): PreparedEmbeddingsRequest {
  if (!getTokenCredentials().copilotToken) throw new Error("Copilot token not found")
  const normalizedPayload = {
    ...payload,
    input: typeof payload.input === "string" ? [payload.input] : payload.input,
  }
  return {
    url: `${copilotBaseUrl(state)}/embeddings`,
    payload: normalizedPayload,
    headers: copilotHeaders(state),
    signal: undefined,
    responseHeaderTimeoutMs: resolveResponseHeaderTimeoutMs(payload.model),
  }
}

/** Execute one already-prepared embeddings exchange and expose its HTTP envelope. */
export async function executeEmbeddingsRequest(prepared: PreparedEmbeddingsRequest): Promise<EmbeddingsExchange> {
  const response = await upstreamFetch(prepared.url, {
    method: "POST",
    headers: prepared.headers,
    body: JSON.stringify(prepared.payload),
    signal: prepared.signal,
    responseHeaderTimeoutMs: prepared.responseHeaderTimeoutMs,
  })
  if (!response.ok) throw await HTTPError.fromResponse("Failed to create embeddings", response)
  return {
    body: (await response.json()) as EmbeddingResponse,
    status: response.status,
    headers: response.headers,
  }
}

/** Public compatibility facade for non-observing callers. */
export const createEmbeddings = async (payload: EmbeddingRequest): Promise<EmbeddingResponse> => {
  const exchange = await executeEmbeddingsRequest(prepareEmbeddingsRequest(payload))
  return exchange.body
}
