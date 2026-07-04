import consola from "consola"

import {
  //
  copilotBaseUrl,
  copilotHeaders,
} from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { createResponseHeaderTimeoutSignal } from "~/lib/fetch-utils"
import {
  //
  state,
  setModels,
} from "~/lib/state"
import { upstreamFetch } from "~/lib/transport/upstream-fetch"

/**
 * Cached ETag from the last successful /models response.
 * Sent as `If-None-Match` on subsequent requests; a 304 response means the
 * server confirmed our cache is current and we skip the JSON parse + setModels.
 * Module-scoped so it survives across refresh-loop ticks but resets on process restart.
 */
let modelsEtag: string | undefined

/** Test helper — reset the cached ETag to simulate a fresh process. */
export function resetModelsEtagForTests(): void {
  modelsEtag = undefined
}

/** Fetch models from Copilot API and cache in global state. Skips setModels on 304 Not Modified. */
export async function cacheModels(): Promise<void> {
  const models = await getModels()
  if (models) setModels(models)
}

/**
 * Fetch the /models catalog.
 *
 * Returns `undefined` when the server replies 304 Not Modified — in that case
 * the caller should keep its current cache unchanged. Returns the parsed body
 * on 200 OK.
 */
export const getModels = async (): Promise<ModelsResponse | undefined> => {
  const headers = copilotHeaders(state)
  if (modelsEtag) headers["If-None-Match"] = modelsEtag

  const response = await upstreamFetch(`${copilotBaseUrl(state)}/models`, {
    headers,
    signal: createResponseHeaderTimeoutSignal(),
  })

  if (response.status === 304) {
    consola.debug("[Models] 304 Not Modified — keeping cached catalog")
    return undefined
  }

  if (!response.ok) throw await HTTPError.fromResponse("Failed to get models", response)

  const etag = response.headers.get("etag")
  if (etag) modelsEtag = etag

  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface VisionLimits {
  max_prompt_image_size?: number
  max_prompt_images?: number
  supported_media_types?: Array<string>
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_non_streaming_output_tokens?: number
  max_inputs?: number
  vision?: VisionLimits
}

interface ModelSupports {
  /**
   * Arbitrary capability flags. Copilot returns booleans (vision, streaming, …),
   * numbers (min/max_thinking_budget), and string arrays (reasoning_effort).
   */
  [key: string]: boolean | number | Array<string> | undefined
}

interface ModelCapabilities {
  family?: string
  limits?: ModelLimits
  object?: string
  supports?: ModelSupports
  tokenizer?: string
  type?: string
}

export interface Model {
  billing?: {
    is_premium?: boolean
    multiplier?: number
    restricted_to?: Array<string>
  }
  capabilities?: ModelCapabilities
  id: string
  model_picker_category?: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  is_chat_default: boolean
  is_chat_fallback: boolean
  /** Model-specific request headers from CAPI (forwarded to upstream API requests) */
  request_headers?: Record<string, string>
  supported_endpoints?: Array<string>
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
}
