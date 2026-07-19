import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientFormat } from "~/lib/pipeline/envelope"
import type { ClientFrameEnvelope } from "~/lib/pipeline/stream/frame-envelope"

import { createCandidateBoundaryClassifier } from "~/lib/pipeline/generation/boundary-classifier"
import { createClientFrameEnvelope } from "~/lib/pipeline/stream/frame-envelope"

function frame(payload: Record<string, unknown>, event?: string, synthetic = false): ClientFrameEnvelope {
  return createClientFrameEnvelope(
    { ...(event && { event }), data: JSON.stringify(payload) },
    {
      sequence: 0,
      observedAtMonotonic: 1,
      provenance: synthetic ? { kind: "synthetic", syntheticKind: "test" } : { kind: "candidate", candidateId: "candidate-1", dispatchId: "dispatch-1" },
    },
  )
}

function classifier(format: ClientFormat) {
  return createCandidateBoundaryClassifier(format)
}

describe("candidate boundary classifier", () => {
  test("Anthropic wins only on a real complete content block", () => {
    const boundary = classifier("anthropic")
    const stop = frame({ type: "content_block_stop", index: 0 }, "content_block_stop")

    expect(
      boundary.observe(frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, "content_block_start")),
    ).toBeNull()
    expect(
      boundary.observe(frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "x" } }, "content_block_delta")),
    ).toBeNull()
    const result = boundary.observe(stop)
    expect(result).toMatchObject({ kind: "successful-boundary", frame: stop })
    expect(boundary.result).toBe(result)
    expect(boundary.observe(stop)).toBeNull()
  })

  test("synthetic Anthropic completion never wins", () => {
    const boundary = classifier("anthropic")
    boundary.observe(frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start", true))
    const stop = frame({ type: "content_block_stop", index: 0 }, "content_block_stop", true)

    expect(boundary.observe(stop)).toBeNull()
  })

  test("mixed real and synthetic Anthropic boundaries never win", () => {
    const realStartSyntheticStop = classifier("anthropic")
    realStartSyntheticStop.observe(frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start"))
    expect(realStartSyntheticStop.observe(frame({ type: "content_block_stop", index: 0 }, "content_block_stop", true))).toBeNull()

    const syntheticStartRealStop = classifier("anthropic")
    syntheticStartRealStop.observe(frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start", true))
    expect(syntheticStartRealStop.observe(frame({ type: "content_block_stop", index: 0 }, "content_block_stop"))).toBeNull()
  })

  test("Responses wins on a real output_item.done from event or data type", () => {
    const eventBoundary = classifier("openai-responses")
    const eventDone = frame({ type: "response.output_item.done", output_index: 0 }, "response.output_item.done")
    expect(eventBoundary.observe(eventDone)).toMatchObject({ kind: "successful-boundary", frame: eventDone })

    const dataBoundary = classifier("openai-responses")
    const dataDone = frame({ type: "response.output_item.done", output_index: 0 })
    expect(dataBoundary.observe(dataDone)).toMatchObject({ kind: "successful-boundary", frame: dataDone })
    expect(classifier("openai-responses").observe(frame({ type: "response.output_text.delta", delta: "x" }, "response.output_text.delta"))).toBeNull()
    expect(classifier("openai-responses").observe(frame({ type: "response.output_item.done", output_index: 0 }, "response.output_item.done", true))).toBeNull()
  })

  test("Chat Completions wins on the first non-empty finish_reason", () => {
    const boundary = classifier("openai-cc")
    expect(boundary.observe(frame({ choices: [{ delta: { content: "x" }, finish_reason: null }] }))).toBeNull()
    expect(boundary.observe(frame({ choices: [{ delta: {}, finish_reason: "" }] }))).toBeNull()
    const terminal = frame({ choices: [{ delta: {}, finish_reason: "stop" }] })
    expect(boundary.observe(terminal)).toMatchObject({ kind: "successful-boundary", frame: terminal })
  })

  test("Gemini wins on a specified candidate finish reason", () => {
    const boundary = classifier("gemini")
    expect(boundary.observe(frame({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "FINISH_REASON_UNSPECIFIED" }] }))).toBeNull()
    const terminal = frame({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }] })
    expect(boundary.observe(terminal)).toMatchObject({ kind: "successful-boundary", frame: terminal })
  })

  test("malformed, typeless, and terminal error frames never win", () => {
    for (const format of ["anthropic", "openai-responses", "openai-cc", "gemini"] as const satisfies ReadonlyArray<ClientFormat>) {
      expect(
        classifier(format).observe(
          createClientFrameEnvelope(
            { data: "{" },
            { sequence: 0, observedAtMonotonic: 1, provenance: { kind: "candidate", candidateId: "candidate-1", dispatchId: "dispatch-1" } },
          ),
        ),
      ).toBeNull()
      expect(classifier(format).observe(frame({ type: "error", error: { message: "boom" } }, "error"))).toBeNull()
      expect(
        classifier(format).observe(
          createClientFrameEnvelope(
            {},
            { sequence: 0, observedAtMonotonic: 1, provenance: { kind: "candidate", candidateId: "candidate-1", dispatchId: "dispatch-1" } },
          ),
        ),
      ).toBeNull()
    }
  })
})
