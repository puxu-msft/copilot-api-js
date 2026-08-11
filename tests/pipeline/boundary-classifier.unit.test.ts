import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { DeliveryOutcome } from "~/lib/pipeline/delivery/protocol"

import { createCandidateBoundaryClassifier } from "~/lib/pipeline/generation/boundary-classifier"
import { createClientFrameEnvelope } from "~/lib/pipeline/stream/frame-envelope"

function frame(synthetic = false) {
  return createClientFrameEnvelope(
    { data: "wire payload is deliberately opaque" },
    {
      sequence: 0,
      observedAtMonotonic: 1,
      provenance: synthetic ? { kind: "synthetic", syntheticKind: "test" } : { kind: "candidate", candidateId: "candidate-1", dispatchId: "dispatch-1" },
    },
  )
}

const completeUnit: DeliveryOutcome = { kind: "complete-unit", unit: { boundary: "content-block", frames: [{ data: "closed" }] } }
const completeTerminal: DeliveryOutcome = {
  kind: "response-terminal",
  terminal: { semantic: "complete", sourceFrame: null, diagnostic: { source: "finish-result", terminal: "stop" } },
  responseFrames: [],
}
const failedTerminal: DeliveryOutcome = {
  kind: "response-terminal",
  terminal: { semantic: "failed", sourceFrame: null, diagnostic: { source: "finish-result", terminal: "failed" } },
  responseFrames: [],
}

describe("candidate boundary classifier", () => {
  test("projects readiness from complete-unit and legal successful response-terminal outcomes", () => {
    const unitBoundary = createCandidateBoundaryClassifier()
    const unitFrame = frame()
    expect(unitBoundary.observe(completeUnit, unitFrame)).toMatchObject({ kind: "successful-boundary", frame: unitFrame })

    const terminalBoundary = createCandidateBoundaryClassifier()
    const terminalFrame = frame()
    expect(terminalBoundary.observe(completeTerminal, terminalFrame)).toMatchObject({ kind: "successful-boundary", frame: terminalFrame })
  })

  test("ignores append-only, failed, synthetic, and duplicate outcomes without parsing wire JSON", () => {
    const boundary = createCandidateBoundaryClassifier()
    expect(boundary.observe({ kind: "buffer-real-frame", frame: { data: "{" } }, frame())).toBeNull()
    expect(boundary.observe(failedTerminal, frame())).toBeNull()
    expect(boundary.observe(completeUnit, frame(true))).toBeNull()
    const ready = boundary.observe(completeUnit, frame())
    expect(ready?.kind).toBe("successful-boundary")
    expect(boundary.observe(completeTerminal, frame())).toBeNull()
  })
})
