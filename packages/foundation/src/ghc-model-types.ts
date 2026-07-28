/**
 * GHC `/models` catalog wire types — the shapes the Copilot API actually returns.
 *
 * Foundation-hosted next to `ghc-http-primitives.ts` for the same reason those header constants are:
 * more than one layer needs them and none of them should have to depend on the HTTP client to say
 * what a model looks like. Concretely, `state` holds `models` and a `Map<string, Model>` index and is
 * being reduced to a leaf that depends on nothing but language builtins
 * (docs/plan/2026-07-28-state-to-foundation/HANDOVER.md); the alternative was for `state` to declare
 * a structurally-equivalent copy of a forty-field interface and pin it with an assertion, which is
 * two definitions to keep in step forever. User decision, 2026-07-28.
 *
 * Pure type declarations, no imports. `models/client.ts` re-exports them, so no consumer changed.
 * `InternalModelsResponse` deliberately stayed there: it is OUR `/api/models` envelope, not a GHC
 * wire shape.
 */

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
