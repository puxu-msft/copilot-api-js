import type { ModelData } from "@/composables/useModelsCatalog"

const LEGACY_ENDPOINTS: Record<string, Array<string>> = {
  chat: ["/chat/completions"],
  completion: ["/chat/completions"],
  embeddings: ["/v1/embeddings"],
}

/** Infer legacy model endpoints from capabilities.type when upstream omits supported_endpoints. */
export function getEffectiveEndpoints(model: ModelData): Array<string> {
  const explicit = model.supported_endpoints as Array<string> | undefined
  if (explicit) return explicit

  const type = model.capabilities?.type as string | undefined
  if (type && type in LEGACY_ENDPOINTS) {
    return LEGACY_ENDPOINTS[type]
  }

  return []
}
