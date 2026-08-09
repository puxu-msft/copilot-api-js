import type { DeliveryOutcome } from "~/lib/pipeline/delivery/protocol"
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
  observe(outcome: DeliveryOutcome, frame: ClientFrameEnvelope): CandidateBoundaryReady | null
}

/** Project hedge readiness from the shared grammar outcome stream without interpreting wire payloads. */
export function createCandidateBoundaryClassifier(): CandidateBoundaryClassifier {
  let result: CandidateBoundaryReady | null = null

  const observe = (outcome: DeliveryOutcome, frame: ClientFrameEnvelope): CandidateBoundaryReady | null => {
    if (result || frame.provenance.kind === "synthetic") return null
    const signals = signalsFor(outcome)
    if (!signals || !isSemanticCommitBoundary(signals)) return null
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

function signalsFor(outcome: DeliveryOutcome): ClientFrameSignals | undefined {
  if (outcome.kind === "complete-unit") return { synthetic: false, semanticContent: true, blockBoundary: true, terminal: "none" }
  if (outcome.kind === "response-terminal" && outcome.terminal.semantic === "complete") {
    return { synthetic: false, semanticContent: true, blockBoundary: true, terminal: "success" }
  }
  return undefined
}
