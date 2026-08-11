import type { ClientFrame } from "~/lib/pipeline/types"

/** Canonical Anthropic in-band SSE error frame shared below route handlers. */
export function anthropicErrorFrame(type: string, message: string): ClientFrame {
  return { event: "error", data: JSON.stringify({ type: "error", error: { type, message } }) }
}
