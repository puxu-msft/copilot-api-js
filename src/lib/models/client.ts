import { copilotBaseUrl, copilotHeaders } from "~/lib/copilot-api"
import { HTTPError } from "~/lib/error"
import { createFetchSignal } from "~/lib/fetch-utils"
import { state, setModels } from "~/lib/state"

/** Fetch models from Copilot API and cache in global state */
export async function cacheModels(): Promise<void> {
  const models = await getModels()
  setModels(models)
}

export const getModels = async () => {
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotHeaders(state),
    signal: createFetchSignal(),
  })

  if (!response.ok) throw await HTTPError.fromResponse("Failed to get models", response)

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
  [key: string]: boolean | number | undefined
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
