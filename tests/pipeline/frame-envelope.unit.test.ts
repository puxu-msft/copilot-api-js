import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  createClientFrameEnvelope,
  createUpstreamFrameEnvelope,
  isSemanticCommitBoundary,
} from "~/lib/pipeline/stream/frame-envelope"

describe("P1-T1 additive frame envelopes", () => {
  test("preserves the exact raw frame object and unknown fields", () => {
    const raw = { event: "future.event", data: '{"future":true}', id: "evt-1", retry: 7, futureWireField: { nested: true } }
    const envelope = createUpstreamFrameEnvelope(raw, {
      sequence: 3,
      observedAtMonotonic: 125.5,
      provenance: { kind: "upstream", dispatchId: "dispatch-1" },
    })

    expect(envelope.frame).toBe(raw)
    expect(envelope.frame.futureWireField).toEqual({ nested: true })
    expect(envelope.sequence).toBe(3)
    expect(envelope.observedAtMonotonic).toBe(125.5)
    expect(envelope.provenance).toEqual({ kind: "upstream", dispatchId: "dispatch-1" })
    expect(Object.isFrozen(envelope)).toBe(true)
    expect(Object.isFrozen(raw)).toBe(false)
  })

  test("keeps post-render frame identity and additive provenance", () => {
    const rendered = { event: "content_block_stop", data: '{"type":"content_block_stop","index":0}' }
    const envelope = createClientFrameEnvelope(rendered, {
      sequence: 9,
      observedAtMonotonic: 300,
      provenance: { kind: "candidate", candidateId: "primary", dispatchId: "dispatch-1" },
    })

    expect(envelope.frame).toBe(rendered)
    expect(envelope.provenance.kind).toBe("candidate")
    expect(Object.isFrozen(envelope)).toBe(true)
    expect(Object.isFrozen(rendered)).toBe(false)
  })

  test("synthetic frames can never become semantic commit boundaries", () => {
    expect(isSemanticCommitBoundary({ synthetic: true, semanticContent: true, blockBoundary: true, terminal: "none" })).toBe(false)
    expect(isSemanticCommitBoundary({ synthetic: false, semanticContent: true, blockBoundary: true, terminal: "none" })).toBe(true)
    expect(isSemanticCommitBoundary({ synthetic: false, semanticContent: true, blockBoundary: true, terminal: "success" })).toBe(true)
    expect(isSemanticCommitBoundary({ synthetic: false, semanticContent: true, blockBoundary: true, terminal: "valid-without-boundary" })).toBe(false)
    expect(isSemanticCommitBoundary({ synthetic: false, semanticContent: false, blockBoundary: true, terminal: "success" })).toBe(false)
    expect(isSemanticCommitBoundary({ synthetic: false, semanticContent: true, blockBoundary: false, terminal: "success" })).toBe(false)
    expect(isSemanticCommitBoundary({ synthetic: false, semanticContent: true, blockBoundary: true, terminal: "failure" })).toBe(false)
  })
})
