import type { Model } from "./client"

// ============================================================================
// Copilot API endpoint identifiers
// ============================================================================

export const ENDPOINT = {
  MESSAGES: "/v1/messages",
  CHAT_COMPLETIONS: "/chat/completions",
  RESPONSES: "/responses",
  /** WebSocket transport for Responses API. */
  WS_RESPONSES: "ws:/responses",
  EMBEDDINGS: "/v1/embeddings",
} as const

/** Capability type → default endpoints for legacy models without `supported_endpoints` */
const LEGACY_ENDPOINTS: Record<string, Array<string>> = {
  chat: [ENDPOINT.CHAT_COMPLETIONS],
  completion: [ENDPOINT.CHAT_COMPLETIONS],
  embeddings: [ENDPOINT.EMBEDDINGS],
}

/**
 * Get the effective endpoint list for a model.
 *
 * Returns `supported_endpoints` when present, otherwise infers from
 * `capabilities.type` for legacy models that predate the field.
 */
export function getEffectiveEndpoints(model: Model): Array<string> | undefined {
  if (model.supported_endpoints) return model.supported_endpoints
  const type = model.capabilities?.type
  if (type) return LEGACY_ENDPOINTS[type]
  return undefined
}

// ============================================================================
// Endpoint support checks
// ============================================================================

/**
 * Check if a model supports a given API endpoint.
 *
 * When `supported_endpoints` is absent (legacy models like gpt-4, gemini),
 * we assume all endpoints are supported — these models predate the field
 * and rely on /chat/completions as a universal fallback.
 */
export function isEndpointSupported(model: Model | undefined, endpoint: string): boolean {
  if (!model?.supported_endpoints) return true
  return model.supported_endpoints.includes(endpoint)
}

/**
 * Check if a model supports the Responses API via either transport:
 * HTTP (`/responses`) or WebSocket (`ws:/responses`).
 */
export function isResponsesSupported(model: Model | undefined): boolean {
  return isEndpointSupported(model, ENDPOINT.RESPONSES) || isEndpointSupported(model, ENDPOINT.WS_RESPONSES)
}

/**
 * Check if a model explicitly supports upstream WebSocket transport for Responses API.
 *
 * Unlike `isEndpointSupported`, legacy models without `supported_endpoints` do not
 * implicitly gain WebSocket support. We only enable this transport when Copilot has
 * advertised the dedicated `ws:/responses` capability.
 */
export function isWsResponsesSupported(model: Model | undefined): boolean {
  if (!model?.supported_endpoints) return false
  return model.supported_endpoints.includes(ENDPOINT.WS_RESPONSES)
}

/**
 * Assert that a model supports a given endpoint, throwing a descriptive error if not.
 * Returns the validated model for chaining.
 */
export function assertEndpointSupported(model: Model | undefined, endpoint: string): void {
  if (isEndpointSupported(model, endpoint)) return

  const modelId = model?.id ?? "unknown"
  const supported = model?.supported_endpoints?.join(", ") ?? "none"
  const msg = `Model "${modelId}" does not support ${endpoint}. Supported endpoints: ${supported}`
  throw new Error(msg)
}
