import { copilotHeaders, copilotBaseUrl } from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { createFetchSignal } from "~/lib/fetch-utils"
import { state } from "~/lib/state"

export const createEmbeddings = async (payload: EmbeddingRequest) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  // Normalize input to array — some API providers reject bare string input
  const normalizedPayload = {
    ...payload,
    input: typeof payload.input === "string" ? [payload.input] : payload.input,
  }

  const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
    method: "POST",
    headers: copilotHeaders(state),
    body: JSON.stringify(normalizedPayload),
    signal: createFetchSignal(),
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
