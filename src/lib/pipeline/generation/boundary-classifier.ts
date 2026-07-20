import type { ClientFormat } from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrameEnvelope,
  ClientFrameSignals,
} from "~/lib/pipeline/stream/frame-envelope"

import { isSemanticCommitBoundary } from "~/lib/pipeline/stream/frame-envelope"

export interface CandidateBoundaryReady {
  readonly kind: "successful-boundary"
  readonly frame: ClientFrameEnvelope
  readonly signals: ClientFrameSignals
  readonly completedAtMonotonic: number
}

export interface CandidateBoundaryClassifier {
  readonly result: CandidateBoundaryReady | null
  observe(frame: ClientFrameEnvelope): CandidateBoundaryReady | null
}

/** Build one stateful, candidate-local classifier over final post-transform client frames. */
export function createCandidateBoundaryClassifier(format: ClientFormat): CandidateBoundaryClassifier {
  const realAnthropicBlocks = new Set<number>()
  let result: CandidateBoundaryReady | null = null

  const observe = (frame: ClientFrameEnvelope): CandidateBoundaryReady | null => {
    if (result) return null
    const synthetic = frame.provenance.kind === "synthetic"
    const payload = parsePayload(frame.frame.data)
    if (!payload) return null

    switch (format) {
      case "anthropic": {
        if (payload.type === "content_block_start" && typeof payload.index === "number" && !synthetic) realAnthropicBlocks.add(payload.index)
        if (payload.type !== "content_block_stop" || typeof payload.index !== "number") return null
        const closesRealBlock = realAnthropicBlocks.delete(payload.index)
        if (!closesRealBlock || synthetic) return null
        return commit(frame, { synthetic, semanticContent: true, blockBoundary: true, terminal: "none" })
      }
      case "openai-responses": {
        if (synthetic) return null
        const type = frame.frame.event ?? payload.type
        if (type !== "response.output_item.done") return null
        return commit(frame, { synthetic, semanticContent: true, blockBoundary: true, terminal: "none" })
      }
      case "openai-cc": {
        if (synthetic) return null
        const choices = Array.isArray(payload.choices) ? payload.choices : []
        const complete = choices.some((choice) => {
          if (!choice || typeof choice !== "object") return false
          const finishReason = (choice as { finish_reason?: unknown }).finish_reason
          return typeof finishReason === "string" && finishReason.length > 0
        })
        if (!complete) return null
        return commit(frame, { synthetic, semanticContent: true, blockBoundary: true, terminal: "success" })
      }
      case "gemini": {
        if (synthetic) return null
        const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
        const complete = candidates.some((candidate) => {
          if (!candidate || typeof candidate !== "object") return false
          const finishReason = (candidate as { finishReason?: unknown }).finishReason
          return typeof finishReason === "string" && finishReason.length > 0 && finishReason !== "FINISH_REASON_UNSPECIFIED"
        })
        if (!complete) return null
        return commit(frame, { synthetic, semanticContent: true, blockBoundary: true, terminal: "success" })
      }
      default: {
        return assertNever(format)
      }
    }
  }

  const commit = (frame: ClientFrameEnvelope, signals: ClientFrameSignals): CandidateBoundaryReady | null => {
    if (!isSemanticCommitBoundary(signals)) return null
    result = Object.freeze({ kind: "successful-boundary", frame, signals: Object.freeze(signals), completedAtMonotonic: frame.observedAtMonotonic })
    return result
  }

  return {
    get result() {
      return result
    },
    observe,
  }
}

function assertNever(value: never): never {
  throw new Error(`[candidate-boundary] unsupported client format: ${String(value)}`)
}

function parsePayload(data: string | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined
  try {
    const parsed: unknown = JSON.parse(data)
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
