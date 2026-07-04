import {
  //
  copilotHeaders,
  copilotBaseUrl,
} from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { createResponseHeaderTimeoutSignal } from "~/lib/fetch-utils"
import { getShutdownSignal } from "~/lib/shutdown"
import { state } from "~/lib/state"
import { combineAbortSignals } from "~/lib/stream"
import { upstreamFetch } from "~/lib/transport/upstream-fetch"

export const createEmbeddings = async (payload: EmbeddingRequest) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  // Normalize input to array — some API providers reject bare string input
  const normalizedPayload = {
    ...payload,
    input: typeof payload.input === "string" ? [payload.input] : payload.input,
  }

  const response = await upstreamFetch(`${copilotBaseUrl(state)}/embeddings`, {
    method: "POST",
    headers: copilotHeaders(state),
    body: JSON.stringify(normalizedPayload),
    // Embeddings are always non-streaming, so fold in the shutdown signal: a
    // Phase 3 abort interrupts the request instead of hanging until force-close.
    signal: combineAbortSignals(createResponseHeaderTimeoutSignal(), getShutdownSignal()),
  })

  if (!response.ok) throw await HTTPError.fromResponse("Failed to create embeddings", response)

  return (await response.json()) as EmbeddingResponse
}

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
