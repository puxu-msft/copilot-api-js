import type { MessageFormat } from "./normalize-message"
import type { EndpointType } from "./types"

/** Map a persisted endpoint to the normalization format (Responses ≈ chat = openai). */
export function formatFromEndpoint(endpoint: EndpointType): MessageFormat {
  switch (endpoint) {
    case "anthropic-messages": {
      return "anthropic"
    }
    case "gemini-generate-content": {
      return "gemini"
    }
    default: {
      return "openai"
    }
  }
}
