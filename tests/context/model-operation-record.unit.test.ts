import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import type {
  //
  ArenaNodeOrigin,
  FrameNodeHandle,
  OperationKind,
  PayloadNodeHandle,
} from "~/lib/context/model-operation-record"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"

const clientIngress: ArenaNodeOrigin = { stage: "ingress", track: "client" }
const upstreamEgress: ArenaNodeOrigin = { stage: "egress", track: "upstream" }
const clientEgress: ArenaNodeOrigin = { stage: "egress", track: "client" }

function makeRecorder(kind: OperationKind = "generation") {
  return createModelOperationRecorder({
    identity: {
      operationId: `op-${kind}`,
      kind,
      createdAt: 1_721_111_111_111,
      sessionId: "session-1",
    },
  })
}

describe("ModelOperationRecord canonical shape", () => {
  it.each(["generation", "count_tokens", "embeddings", "responses_ws"] satisfies ReadonlyArray<OperationKind>)("represents the %s operation kind", (kind) => {
    const record = makeRecorder(kind).snapshot()

    expect(record.identity.kind).toBe(kind)
    expect(record.ingress).toBeNull()
    expect(record.routing).toBeNull()
    expect(record.transforms).toEqual([])
    expect(record.attempts).toEqual([])
    expect(record.egress).toBeNull()
    expect(record.terminal).toBeNull()
  })

  it("retains source values by readonly reference while freezing arena-owned containers", () => {
    const recorder = makeRecorder()
    const payload = { model: "claude-opus-4.8", messages: [{ role: "user", content: "hello" }] }
    const frame = { type: "message_start", message: { id: "msg-1" } }
    const payloadHandle = recorder.registerPayload(payload, { origin: clientIngress, mediaType: "application/json" })
    const frameHandle = recorder.registerFrame(frame, { origin: upstreamEgress, mediaType: "text/event-stream" })

    const record = recorder.snapshot()
    expect(record.arena.payloads[0]?.value).toBe(payload)
    expect(record.arena.frames[0]?.value).toBe(frame)
    expect(Object.isFrozen(payload)).toBe(false)
    expect(Object.isFrozen(frame)).toBe(false)
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record.arena)).toBe(true)
    expect(Object.isFrozen(record.arena.payloads)).toBe(true)
    expect(Object.isFrozen(record.arena.frames)).toBe(true)
    expect(Object.isFrozen(record.arena.payloads[0])).toBe(true)
    expect(Object.isFrozen(record.arena.frames[0])).toBe(true)
    expect(record.arena.payloads[0]?.handle).toBe(payloadHandle)
    expect(record.arena.frames[0]?.handle).toBe(frameHandle)
  })

  it("allows unchanged upstream and client tracks to share nodes without coupling their containers", () => {
    const recorder = makeRecorder()
    const payload = recorder.registerPayload({ content: "same bytes" }, { origin: upstreamEgress })
    const frame = recorder.registerFrame("data: unchanged\n\n", { origin: upstreamEgress })

    recorder.recordEgress({
      upstream: { payload, frames: [frame], status: 200 },
      client: { payload, frames: [frame], status: 200 },
    })

    const record = recorder.snapshot()
    expect(record.arena.payloads).toHaveLength(1)
    expect(record.arena.frames).toHaveLength(1)
    expect(record.egress?.upstream.payload).toBe(record.egress?.client.payload)
    expect(record.egress?.upstream.frames[0]).toBe(record.egress?.client.frames[0])
    expect(record.egress?.upstream).not.toBe(record.egress?.client)
    expect(record.egress?.upstream.frames).not.toBe(record.egress?.client.frames)
  })

  it("requires explicit provenance for every derived payload and frame and keeps tracks independent", () => {
    const recorder = makeRecorder()
    const sourcePayload = recorder.registerPayload({ model: "wire-model" }, { origin: upstreamEgress })
    const sourceFrame = recorder.registerFrame({ type: "response.output_text.delta", delta: "hello" }, { origin: upstreamEgress })
    const clientPayload = recorder.derivePayload(
      { model: "client-model" },
      { derivedFrom: sourcePayload, origin: clientEgress, transformId: "responses-to-anthropic:payload" },
    )
    const clientFrame = recorder.deriveFrame(
      { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
      { derivedFrom: sourceFrame, origin: clientEgress, transformId: "responses-to-anthropic:frame" },
    )

    recorder.recordTransform({
      transformId: "responses-to-anthropic:frame",
      stage: "render",
      inputs: [{ kind: "frame", handle: sourceFrame }],
      outputs: [{ kind: "frame", handle: clientFrame }],
    })
    recorder.recordEgress({
      upstream: { payload: sourcePayload, frames: [sourceFrame] },
      client: { payload: clientPayload, frames: [clientFrame] },
    })

    const record = recorder.snapshot()
    const derivedPayload = record.arena.payloads.find((node) => node.handle === clientPayload)
    const derivedFrame = record.arena.frames.find((node) => node.handle === clientFrame)
    expect(derivedPayload).toMatchObject({
      provenance: "derived",
      derivedFrom: sourcePayload,
      origin: clientEgress,
      transformId: "responses-to-anthropic:payload",
    })
    expect(derivedFrame).toMatchObject({
      provenance: "derived",
      derivedFrom: sourceFrame,
      origin: clientEgress,
      transformId: "responses-to-anthropic:frame",
    })
    expect(record.egress?.upstream.payload).toBe(sourcePayload)
    expect(record.egress?.client.payload).toBe(clientPayload)
    expect(record.egress?.upstream.frames).toEqual([sourceFrame])
    expect(record.egress?.client.frames).toEqual([clientFrame])
  })

  it("preserves diagnostics and verdicts for discarded, failed, and committed attempts", () => {
    const recorder = makeRecorder()
    const request = recorder.registerPayload({ messages: ["full context"] }, { origin: clientIngress })
    const rejectedBody = recorder.registerPayload({ error: "unsupported beta" }, { origin: upstreamEgress })

    const discarded = recorder.beginAttempt({ effectiveRequest: { payload: request }, strategy: "initial" })
    const negotiation = { rejectedBeta: "context-1m-2025-08-07", status: 400 }
    recorder.recordAttemptDiagnostic(discarded, {
      kind: "upstream_rejection",
      severity: "warning",
      message: "Upstream rejected a beta header",
      data: negotiation,
    })
    recorder.settleAttempt(discarded, { verdict: "discarded", upstreamResponse: { payload: rejectedBody }, reason: "reactive retry" })

    const failed = recorder.beginAttempt({ effectiveRequest: { payload: request }, strategy: "retry-without-beta" })
    recorder.recordAttemptDiagnostic(failed, { kind: "transport", severity: "error", data: { code: "RST_STREAM" } })
    recorder.settleAttempt(failed, { verdict: "failed", reason: "transport closed" })

    const committed = recorder.beginAttempt({ effectiveRequest: { payload: request }, strategy: "network-retry" })
    recorder.recordAttemptDiagnostic(committed, { kind: "usage", severity: "info", data: { input_tokens: 42, output_tokens: 7 } })
    recorder.settleAttempt(committed, { verdict: "committed" })

    const record = recorder.snapshot()
    expect(record.attempts.map((attempt) => attempt.verdict)).toEqual(["discarded", "failed", "committed"])
    expect(record.attempts[0]?.diagnostics[0]?.data).toBe(negotiation)
    expect(record.attempts[0]?.diagnostics[0]).toMatchObject({ kind: "upstream_rejection", severity: "warning" })
    expect(record.attempts[0]?.upstreamResponse?.payload).toBe(rejectedBody)
    expect(record.attempts[1]?.diagnostics[0]?.data).toEqual({ code: "RST_STREAM" })
    expect(record.attempts[2]?.diagnostics[0]?.data).toEqual({ input_tokens: 42, output_tokens: 7 })
  })

  it("assigns one globally monotonic sequence across arena and recorder events", () => {
    const recorder = makeRecorder()
    const payload = recorder.registerPayload({ prompt: "hello" }, { origin: clientIngress })
    const sourceFrame = recorder.registerFrame({ delta: "hello" }, { origin: upstreamEgress })
    const clientFrame = recorder.deriveFrame({ delta: "HELLO" }, { derivedFrom: sourceFrame, origin: clientEgress, transformId: "uppercase" })
    recorder.recordIngress({ format: "anthropic-messages", request: { payload } })
    recorder.recordRouting({ requestedModel: "alias", resolvedModel: "claude-opus-4.8", upstreamEndpoint: "/v1/messages" })
    recorder.recordTransform({
      transformId: "uppercase",
      stage: "rewrite-out",
      inputs: [{ kind: "frame", handle: sourceFrame }],
      outputs: [{ kind: "frame", handle: clientFrame }],
    })
    const attempt = recorder.beginAttempt({ effectiveRequest: { payload } })
    recorder.recordAttemptDiagnostic(attempt, { kind: "probe", severity: "info" })
    recorder.settleAttempt(attempt, { verdict: "committed", upstreamResponse: { frames: [sourceFrame] } })
    recorder.recordEgress({ upstream: { frames: [sourceFrame] }, client: { frames: [clientFrame] } })
    const record = recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })

    const sequences = [
      record.arena.payloads[0].sequence,
      record.arena.frames[0].sequence,
      record.arena.frames[1].sequence,
      record.ingress!.sequence,
      record.routing!.sequence,
      record.transforms[0].sequence,
      record.attempts[0].sequence,
      record.attempts[0].diagnostics[0].sequence,
      record.attempts[0].settledSequence!,
      record.egress!.sequence,
      record.terminal!.sequence,
    ]
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    expect(new Set(sequences).size).toBe(sequences.length)
    if (record.terminal === null) throw new Error("terminal record missing")
    expect(record.lastSequence).toBe(record.terminal.sequence)
  })

  it("rejects every recorder mutation after commitTerminal", () => {
    const recorder = makeRecorder()
    const payload = recorder.registerPayload({ prompt: "hello" }, { origin: clientIngress })
    recorder.recordIngress({ request: { payload } })
    const attempt = recorder.beginAttempt({ effectiveRequest: { payload } })
    recorder.settleAttempt(attempt, { verdict: "committed" })
    const committed = recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })

    expect(recorder.sealed).toBe(true)
    expect(() => recorder.registerPayload({}, { origin: clientIngress })).toThrow(/terminal.*committed/i)
    expect(() => recorder.registerFrame({}, { origin: clientIngress })).toThrow(/terminal.*committed/i)
    expect(() => recorder.recordRouting({ requestedModel: "late" })).toThrow(/terminal.*committed/i)
    expect(() => recorder.recordAttemptDiagnostic(attempt, { kind: "late", severity: "info" })).toThrow(/terminal.*committed/i)
    expect(() => recorder.recordEgress({ client: {} })).toThrow(/terminal.*committed/i)
    expect(() => recorder.setExtension("future.late", true)).toThrow(/terminal.*committed/i)
    expect(recorder.snapshot()).toBe(committed)
  })

  it("carries the unique committed attempt into terminal metadata when the caller omits it", () => {
    const recorder = makeRecorder()
    const attempt = recorder.beginAttempt({ strategy: "only-attempt" })
    recorder.settleAttempt(attempt, { verdict: "committed" })

    const record = recorder.commitTerminal({ outcome: "completed" })

    expect(record.terminal?.committedAttempt).toBe(attempt)
  })

  it("rejects terminal commit while an attempt remains open", () => {
    const recorder = makeRecorder()
    recorder.beginAttempt({})

    expect(() => recorder.commitTerminal({ outcome: "failed" })).toThrow(/open attempt/i)
  })

  it("round-trips unknown extension payloads without filtering their fields", () => {
    const recorder = createModelOperationRecorder({
      identity: {
        operationId: "op-extensions",
        kind: "generation",
        createdAt: 1,
        extensions: { "vendor.identity": { opaqueIdentity: 17 } },
      },
      extensions: { "vendor.initial": { nested: { alpha: true }, list: [1, "two", null] } },
    })
    const future = { schema: 99, previouslyUnknown: { enabled: true, labels: ["a", "b"] } }
    recorder.setExtension("vendor.future", future)
    const node = recorder.registerPayload({ prompt: "hello" }, { origin: clientIngress, extensions: { "vendor.node": { unrecognized: "kept" } } })
    recorder.recordIngress({ request: { payload: node }, extensions: { "vendor.ingress": { experimental: 123 } } })
    const record = recorder.commitTerminal({ outcome: "completed", extensions: { "vendor.terminal": { extra: "value" } } })

    expect(record.extensions["vendor.future"]).toBe(future)
    // This assertion intentionally exercises the persistence-neutral JSON wire round-trip.
    // eslint-disable-next-line unicorn/prefer-structured-clone
    const roundTripped = JSON.parse(JSON.stringify(record)) as typeof record
    expect(roundTripped.extensions).toEqual({
      "vendor.initial": { nested: { alpha: true }, list: [1, "two", null] },
      "vendor.future": future,
    })
    expect(roundTripped.identity.extensions).toEqual({ "vendor.identity": { opaqueIdentity: 17 } })
    expect(roundTripped.arena.payloads[0]?.extensions).toEqual({ "vendor.node": { unrecognized: "kept" } })
    expect(roundTripped.ingress?.extensions).toEqual({ "vendor.ingress": { experimental: 123 } })
    expect(roundTripped.terminal?.extensions).toEqual({ "vendor.terminal": { extra: "value" } })
  })

  it("keeps prior immutable snapshots stable as recording continues", () => {
    const recorder = makeRecorder()
    const first = recorder.registerFrame({ index: 0 }, { origin: upstreamEgress })
    const snapshotOne = recorder.snapshot()
    const second = recorder.registerFrame({ index: 1 }, { origin: upstreamEgress })
    const snapshotTwo = recorder.snapshot()

    expect(snapshotOne.arena.frames.map((node) => node.handle)).toEqual([first])
    expect(snapshotTwo.arena.frames.map((node) => node.handle)).toEqual([first, second])
    expect(() => (snapshotOne.arena.frames as Array<unknown>).push({})).toThrow()
  })
})

describe("immutable arena sharing properties", () => {
  it("preserves source sharing and derived provenance over many payload/frame combinations", () => {
    for (let caseIndex = 0; caseIndex < 64; caseIndex++) {
      const recorder = createModelOperationRecorder({ identity: { operationId: `property-${caseIndex}`, kind: "generation", createdAt: caseIndex } })
      const sourcePayload = recorder.registerPayload({ caseIndex }, { origin: upstreamEgress })
      const sourceFrames: Array<FrameNodeHandle> = []
      const clientFrames: Array<FrameNodeHandle> = []
      for (let frameIndex = 0; frameIndex < (caseIndex % 7) + 1; frameIndex++) {
        const source = recorder.registerFrame({ caseIndex, frameIndex }, { origin: upstreamEgress })
        sourceFrames.push(source)
        clientFrames.push(
          caseIndex % 2 === 0 ?
            source
          : recorder.deriveFrame(
              { caseIndex, frameIndex, rendered: true },
              { derivedFrom: source, origin: clientEgress, transformId: `render-${caseIndex}-${frameIndex}` },
            ),
        )
      }
      const clientPayload: PayloadNodeHandle =
        caseIndex % 3 === 0 ?
          sourcePayload
        : recorder.derivePayload(
            { caseIndex, rendered: true },
            { derivedFrom: sourcePayload, origin: clientEgress, transformId: `payload-render-${caseIndex}` },
          )
      recorder.recordEgress({ upstream: { payload: sourcePayload, frames: sourceFrames }, client: { payload: clientPayload, frames: clientFrames } })

      const record = recorder.snapshot()
      expect(record.egress?.upstream.payload).toBe(sourcePayload)
      expect(record.egress?.client.payload).toBe(clientPayload)
      expect(record.arena.payloads).toHaveLength(clientPayload === sourcePayload ? 1 : 2)
      for (const [frameIndex, clientHandle] of clientFrames.entries()) {
        const sourceHandle = sourceFrames[frameIndex]
        if (clientHandle === sourceHandle) {
          expect(record.arena.frames.find((node) => node.handle === clientHandle)?.provenance).toBe("source")
        } else {
          expect(record.arena.frames.find((node) => node.handle === clientHandle)).toMatchObject({
            provenance: "derived",
            derivedFrom: sourceHandle,
            transformId: `render-${caseIndex}-${frameIndex}`,
          })
        }
      }
    }
  })
})
