import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientSink } from "~/lib/pipeline/types"

import { createDeliverySerializer } from "~/lib/pipeline/delivery/serializer"
import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import { createClientFrameEnvelope } from "~/lib/pipeline/stream/frame-envelope"

function frame(type: string, index?: number, blockType?: string) {
  return {
    event: type,
    data: JSON.stringify({
      type,
      ...(index === undefined ? {} : { index }),
      ...(blockType === undefined ? {} : { content_block: { type: blockType } }),
    }),
  }
}

let sequence = 0
function deliveryFrame(value: ReturnType<typeof frame>, syntheticKind?: string) {
  return createClientFrameEnvelope(value, {
    sequence: ++sequence,
    observedAtMonotonic: sequence,
    provenance: syntheticKind ? { kind: "synthetic", syntheticKind } : { kind: "candidate", candidateId: "candidate", dispatchId: "dispatch" },
  })
}

function arraySink(writes: Array<{ method: string; frame: unknown }>): ClientSink {
  return {
    async write(value) {
      writes.push({ method: "write", frame: value })
    },
    async writeKeepalive(value) {
      writes.push({ method: "keepalive", frame: value })
    },
    async writeAnchor(value) {
      writes.push({ method: "anchor", frame: value })
    },
    async writeSyntheticEnvelope(value) {
      writes.push({ method: "envelope", frame: value })
    },
    async writeSynthetic(value) {
      writes.push({ method: "synthetic", frame: value })
    },
    close() {},
  }
}

describe("P3-T1 downstream delivery session", () => {
  test("updates the block ledger only from frames actually written to the client", async () => {
    const writes: Array<{ method: string; frame: unknown }> = []
    let now = 100
    const delivery = createDownstreamDeliverySession({ sink: arraySink(writes), monotonicNow: () => ++now })

    const bufferedButNotWritten = frame("content_block_start", 99, "thinking")
    expect(delivery.snapshot.ledger.openBlocks).toEqual([])
    expect(bufferedButNotWritten).toBeDefined()

    await delivery.writeScaffold([
      deliveryFrame(frame("message_start"), "synthetic-message-start"),
      deliveryFrame(frame("content_block_start", 0, "text"), "anchor"),
      deliveryFrame(frame("content_block_delta", 0), "keepalive"),
    ])
    expect(delivery.snapshot.ledger.messageEnvelope).toBe("synthetic")
    expect(delivery.snapshot.ledger.openBlocks).toEqual([{ index: 0, type: "text", synthetic: true }])
    expect(delivery.snapshot.ledger.semanticBlockCount).toBe(0)
    expect(delivery.snapshot.ledger.lastWriteAtMonotonic).toBe(103)
    expect(delivery.snapshot.writeCount).toBe(3)
    expect(delivery.snapshot.state).toBe("open")

    await delivery.commitWinnerBlock("candidate-primary", [
      deliveryFrame(frame("content_block_stop", 0), "anchor"),
      deliveryFrame(frame("content_block_start", 1, "thinking")),
      deliveryFrame(frame("content_block_delta", 1)),
      deliveryFrame(frame("content_block_stop", 1)),
    ])
    expect(delivery.snapshot.winnerCandidateId).toBe("candidate-primary")
    expect(delivery.snapshot.ledger.openBlocks).toEqual([])
    expect(delivery.snapshot.ledger.semanticBlockCount).toBe(1)
    expect(delivery.snapshot.writeCount).toBe(7)
    expect(writes.map(({ method }) => method)).toEqual(["envelope", "anchor", "keepalive", "anchor", "write", "write", "write"])
  })

  test("survives upstream recovery without resetting identity, ledger, or winner", async () => {
    const writes: Array<{ method: string; frame: unknown }> = []
    const delivery = createDownstreamDeliverySession({ sink: arraySink(writes) })
    const identity = delivery.identity

    await delivery.writeScaffold([deliveryFrame(frame("content_block_start", 0, "text"), "anchor")])
    delivery.noteUpstreamRoundEnded("truncated")
    delivery.noteUpstreamRoundStarted("recovery-1")

    expect(delivery.identity).toBe(identity)
    expect(delivery.snapshot.ledger.openBlocks).toEqual([{ index: 0, type: "text", synthetic: true }])
    expect(delivery.snapshot.upstreamRounds).toEqual(["truncated", "recovery-1"])

    await delivery.commitWinnerBlock("recovery-1", [
      deliveryFrame(frame("content_block_stop", 0), "anchor"),
      deliveryFrame(frame("content_block_start", 1, "text")),
      deliveryFrame(frame("content_block_stop", 1)),
    ])
    expect(delivery.snapshot.winnerCandidateId).toBe("recovery-1")
    expect(delivery.snapshot.ledger.semanticBlockCount).toBe(1)
  })

  test("rejects sibling frames after a winner is selected", async () => {
    const delivery = createDownstreamDeliverySession({ sink: arraySink([]) })
    await delivery.commitWinnerBlock("primary", [frame("content_block_start", 0, "text"), frame("content_block_stop", 0)])

    await expect(delivery.writeWinnerFrame("hedge", frame("message_delta"))).rejects.toThrow(/winner.*primary/)
    await expect(delivery.writeWinnerFrame("primary", frame("message_delta"))).resolves.toBeUndefined()
  })

  test("records real envelopes and terminal writes from actual client wire", async () => {
    const delivery = createDownstreamDeliverySession({ sink: arraySink([]) })
    await delivery.commitWinnerBlock("primary", [deliveryFrame(frame("message_start")), deliveryFrame(frame("message_stop"))])

    expect(delivery.snapshot.ledger.messageEnvelope).toBe("real")
    expect(delivery.snapshot.ledger.terminalWritten).toBe(true)
    expect(delivery.snapshot.writeCount).toBe(2)
  })

  test("serializer rejection does not wedge later delivery work", async () => {
    const serializer = createDeliverySerializer()
    const order: Array<string> = []
    await expect(
      serializer.enqueue(() => {
        order.push("failed")
        throw new Error("write failed")
      }),
    ).rejects.toThrow("write failed")
    await expect(
      serializer.enqueue(() => {
        order.push("recovered")
        return "ok"
      }),
    ).resolves.toBe("ok")
    expect(order).toEqual(["failed", "recovered"])
  })
})
