import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { makeDeliverySseSink } from "~/lib/pipeline/client-sink"
import {
  //
  getDownstreamDeliverySession,
  type DownstreamDeliverySession,
} from "~/lib/pipeline/delivery/session"
import { tagFrameSynthetic } from "~/lib/pipeline/frame-origin"
import { hasDeliveredSemanticContent } from "~/lib/pipeline/generation/semantic-content-gate"
import { isClientContentFrame } from "~/lib/pipeline/request-timing"

function createDelivery() {
  const writes: Array<{ data: string; event?: string }> = []
  const stream = {
    writeSSE(value: { data: string | Promise<string>; event?: string }) {
      if (typeof value.data !== "string") throw new Error("test sink expects synchronous SSE data")
      writes.push({ data: value.data, ...(value.event !== undefined && { event: value.event }) })
      return Promise.resolve()
    },
  } as unknown as Parameters<typeof makeDeliverySseSink>[0]
  const sink = makeDeliverySseSink(stream, {
    isRealContentFrame: (frame) => isClientContentFrame(frame, "anthropic"),
  })
  const session = getDownstreamDeliverySession(sink)
  if (!session) throw new Error("delivery sink must expose its generation-owned session")
  return { writes, sink, session }
}

function contentDelta(text: string) {
  return {
    event: "content_block_delta",
    data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
  }
}

describe("semantic-content gate delivery integration", () => {
  test("flips at the same client-sink egress point as first-real timing", async () => {
    const sessionRef: { current?: DownstreamDeliverySession } = {}
    let gateAtFirstRealCallback: boolean | undefined
    const stream = { writeSSE: () => Promise.resolve() } as unknown as Parameters<typeof makeDeliverySseSink>[0]
    const sink = makeDeliverySseSink(stream, {
      isRealContentFrame: (frame) => isClientContentFrame(frame, "anthropic"),
      onFirstRealContent: () => {
        gateAtFirstRealCallback = hasDeliveredSemanticContent(sessionRef.current)
      },
    })
    const session = getDownstreamDeliverySession(sink)
    if (!session) throw new Error("delivery sink must expose its generation-owned session")
    sessionRef.current = session

    await sink.write(contentDelta("first real content"))

    // The transport's timing callback fires before its async wire write resolves. The delivery-scoped gate
    // is stricter: it flips only after the owner observes that successful write, never on a failed attempt.
    expect(gateAtFirstRealCallback).toBe(false)
    expect(hasDeliveredSemanticContent(session)).toBe(true)
  })

  test("primary synthetic scaffold leaves the gate open and a fresh candidate can emit the first real content", async () => {
    const { writes, sink, session } = createDelivery()

    await sink.writeKeepalive?.(contentDelta(""))
    expect(hasDeliveredSemanticContent(session)).toBe(false)

    // P4/P5 will read this false gate before launching B2. This task intentionally does not launch B2.
    await sink.write(contentDelta("fresh"))

    expect(hasDeliveredSemanticContent(session)).toBe(true)
    expect(writes).toContainEqual({ event: "content_block_delta", data: expect.stringContaining("fresh") })
  })

  test("a primary real delta flips the gate before content_block_stop, preventing a fresh dispatch decision", async () => {
    const { sink, session } = createDelivery()

    await sink.write(contentDelta("already delivered"))
    // Simulate the upstream RST here: no content_block_stop is sent.

    expect(hasDeliveredSemanticContent(session)).toBe(true)
  })

  test("a tagged synthetic rewrite delta does not close the pre-content recovery window", async () => {
    const { sink, session } = createDelivery()

    await sink.write(tagFrameSynthetic(contentDelta("proxy-generated"), "refusal-recovery"))

    expect(hasDeliveredSemanticContent(session)).toBe(false)
  })

  test("a rejected candidate write does not claim client-visible semantic delivery", async () => {
    const stream = {
      writeSSE() {
        return Promise.reject(new Error("client write failed"))
      },
    } as unknown as Parameters<typeof makeDeliverySseSink>[0]
    const sink = makeDeliverySseSink(stream, { isRealContentFrame: (frame) => isClientContentFrame(frame, "anthropic") })
    const session = getDownstreamDeliverySession(sink)
    if (!session) throw new Error("delivery sink must expose its generation-owned session")

    await expect(sink.write(contentDelta("not delivered"))).rejects.toThrow("client write failed")
    expect(hasDeliveredSemanticContent(session)).toBe(false)
  })

  test("owner-allocated candidate writes flip the same delivery-scoped signal", async () => {
    const writes: Array<{ data: string; event?: string }> = []
    const stream = {
      writeSSE(value: { data: string | Promise<string>; event?: string }) {
        if (typeof value.data !== "string") throw new Error("test sink expects synchronous SSE data")
        writes.push({ data: value.data, ...(value.event !== undefined && { event: value.event }) })
        return Promise.resolve()
      },
    } as unknown as Parameters<typeof makeDeliverySseSink>[0]
    const { createGenerationWireIndexAllocator, createGenerationWireState } = await import("~/lib/anthropic/keepalive-anchor")
    const sink = makeDeliverySseSink(stream, {
      wireState: createGenerationWireState(createGenerationWireIndexAllocator()),
      isRealContentFrame: (frame) => isClientContentFrame(frame, "anthropic"),
    })
    const session = getDownstreamDeliverySession(sink)
    if (!session) throw new Error("delivery sink must expose its generation-owned session")
    const leg = await session.allocationPort.beginLeg("recovery", { candidateId: "recovery", dispatchId: "recovery-dispatch" })
    if (!leg.ok) throw new Error(`begin leg failed: ${leg.reason}`)
    const allocated = await session.allocationPort.withAllocatedRealBlock(0, ({ mapping, envelope }) => [
      envelope.real(mapping.remap(contentDelta("buffered"))),
    ])
    expect(allocated.ok).toBe(true)
    expect(hasDeliveredSemanticContent(session)).toBe(true)
    expect(writes).toContainEqual({ event: "content_block_delta", data: expect.stringContaining("buffered") })
  })
})
