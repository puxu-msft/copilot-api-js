import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { OwnerRawSink } from "~/lib/pipeline/delivery/types"

import { createDeliverySerializer } from "~/lib/pipeline/delivery/serializer"
import {
  //
  createDownstreamDeliverySession,
  getDownstreamDeliverySession,
  inheritDownstreamDeliverySession,
} from "~/lib/pipeline/delivery/session"
import { createClientFrameEnvelope } from "~/lib/pipeline/stream/frame-envelope"

import { FakeClock } from "../helpers/fake-clock"

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

async function drain(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

function arraySink(writes: Array<{ method: string; frame: unknown }>): OwnerRawSink {
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
  const clock = new FakeClock()

  test("identity inheritance accepts only the same write-pass-through reference", () => {
    const delivery = createDownstreamDeliverySession({ sink: { async write() {} } })
    const passThrough: ClientSink = { write: delivery.clientSink.write }
    inheritDownstreamDeliverySession(delivery.clientSink, passThrough, { transparency: "write-pass-through" })
    expect(getDownstreamDeliverySession(passThrough)).toBe(delivery)

    const wrapped: ClientSink = { write: (frame) => delivery.clientSink.write(frame) }
    expect(() => inheritDownstreamDeliverySession(delivery.clientSink, wrapped, { transparency: "write-pass-through" })).toThrow(
      "decorator.write must be the same function reference",
    )
  })
  afterEach(() => clock.restore())

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
    expect(delivery.snapshot.ledger.lastWriteAtMonotonic).toBe(104)
    expect(delivery.snapshot.writeCount).toBe(3)
    expect(delivery.snapshot.state).toBe("open")

    delivery.noteWinner({ candidateId: "candidate-primary", dispatchId: "dispatch-primary" })
    await delivery.writeScaffold([deliveryFrame(frame("content_block_stop", 0), "anchor")])
    await delivery.clientSink.write(frame("content_block_start", 1, "thinking"))
    await delivery.clientSink.write(frame("content_block_delta", 1))
    await delivery.clientSink.write(frame("content_block_stop", 1))
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

    delivery.noteWinner({ candidateId: "recovery-1", dispatchId: "recovery-dispatch" })
    await delivery.writeScaffold([deliveryFrame(frame("content_block_stop", 0), "anchor")])
    await delivery.clientSink.write(frame("content_block_start", 1, "text"))
    await delivery.clientSink.write(frame("content_block_stop", 1))
    expect(delivery.snapshot.winnerCandidateId).toBe("recovery-1")
    expect(delivery.snapshot.ledger.semanticBlockCount).toBe(1)
  })

  test("winner identity is recorded without changing the client write path", async () => {
    const writes: Array<{ method: string; frame: unknown }> = []
    const delivery = createDownstreamDeliverySession({ sink: arraySink(writes) })
    delivery.noteWinner({ candidateId: "primary", dispatchId: "dispatch-primary" })
    await delivery.clientSink.write(frame("message_delta"))

    expect(delivery.snapshot.winnerCandidateId).toBe("primary")
    expect(writes.map(({ method }) => method)).toEqual(["write"])
  })

  test("records real envelopes and terminal writes from actual client wire", async () => {
    const delivery = createDownstreamDeliverySession({ sink: arraySink([]) })
    delivery.noteWinner({ candidateId: "primary", dispatchId: "dispatch-primary" })
    await delivery.clientSink.write(frame("message_start"))
    await delivery.clientSink.write(frame("message_stop"))

    expect(delivery.snapshot.ledger.messageEnvelope).toBe("real")
    expect(delivery.snapshot.ledger.terminalWritten).toBe(true)
    expect(delivery.snapshot.writeCount).toBe(2)
  })

  test("freezeHeartbeat is recoverable: resumeHeartbeat revives the timer", async () => {
    clock.install()
    const writes: Array<{ method: string; frame: unknown }> = []
    const delivery = createDownstreamDeliverySession({
      sink: arraySink(writes),
      monotonicNow: Date.now,
      heartbeat: {
        intervalMs: 20_000,
        frame: () => ({ event: "ping", data: '{"type":"ping"}' }),
      },
    })

    delivery.clientSink.suspendHeartbeat?.()
    delivery.clientSink.freezeHeartbeat?.()
    await delivery.clientSink.write(frame("content_block_stop", 0))
    delivery.clientSink.resumeHeartbeat?.()
    writes.length = 0
    for (let i = 0; i < 4; i++) {
      await clock.advance(20_000)
      await drain()
    }

    expect(writes.length).toBeGreaterThan(0)
    expect(writes.every(({ frame: value }) => (value as { event?: string }).event === "ping")).toBe(true)
    delivery.clientSink.close?.()
  })

  test("close permanently stops heartbeat but keeps the write port usable for terminal structure", async () => {
    clock.install()
    const writes: Array<{ method: string; frame: unknown }> = []
    const delivery = createDownstreamDeliverySession({
      sink: arraySink(writes),
      monotonicNow: Date.now,
      heartbeat: {
        intervalMs: 20_000,
        frame: () => ({ event: "ping", data: '{"type":"ping"}' }),
      },
    })

    delivery.clientSink.suspendHeartbeat?.()
    delivery.clientSink.close?.()
    await (delivery.clientSink as OwnerRawSink).writeAnchor?.(frame("content_block_stop", 0))
    delivery.clientSink.resumeHeartbeat?.()
    for (let i = 0; i < 4; i++) {
      await clock.advance(20_000)
      await drain()
    }

    expect(writes).toEqual([{ method: "anchor", frame: frame("content_block_stop", 0) }])
  })

  test("on-demand heartbeat stays ping-only before the content deadline", async () => {
    clock.install()
    const writes: Array<{ method: string; frame: unknown }> = []
    const delivery = createDownstreamDeliverySession({
      sink: arraySink(writes),
      monotonicNow: Date.now,
      heartbeat: {
        intervalMs: 20_000,
        contentDeadlineMs: 200_000,
        frame: () => ({ event: "ping", data: '{"type":"ping"}' }),
        contentFrame: () => ({ event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}' }),
      },
    })

    await delivery.clientSink.write(frame("content_block_start", 0, "text"))
    writes.length = 0
    for (let elapsed = 0; elapsed < 180_000; elapsed += 20_000) {
      await clock.advance(20_000)
      await drain()
    }
    expect(writes).toHaveLength(9)
    expect(writes.every(({ frame: value }) => (value as { event?: string }).event === "ping")).toBe(true)
    delivery.clientSink.close?.()
  })

  test("on-demand heartbeat escalates at the content deadline and repeats on that cadence", async () => {
    clock.install()
    const writes: Array<{ method: string; frame: unknown }> = []
    const delivery = createDownstreamDeliverySession({
      sink: arraySink(writes),
      monotonicNow: Date.now,
      heartbeat: {
        intervalMs: 20_000,
        contentDeadlineMs: 200_000,
        frame: () => ({ event: "ping", data: '{"type":"ping"}' }),
        contentFrame: () => ({ event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}' }),
      },
    })

    await delivery.clientSink.write(frame("content_block_start", 0, "text"))
    writes.length = 0
    for (let elapsed = 0; elapsed < 200_000; elapsed += 20_000) {
      await clock.advance(20_000)
      await drain()
    }
    expect(writes.at(-1)?.frame).toMatchObject({ event: "content_block_delta" })
    for (let elapsed = 0; elapsed < 180_000; elapsed += 20_000) {
      await clock.advance(20_000)
      await drain()
    }
    expect(writes.at(-1)?.frame).toMatchObject({ event: "ping" })
    await clock.advance(20_000)
    await drain()
    expect(writes.at(-1)?.frame).toMatchObject({ event: "content_block_delta" })
    delivery.clientSink.close?.()
  })

  test("on-demand escalation injects a content scaffold only when no block is open", async () => {
    clock.install()
    const writes: Array<{ method: string; frame: unknown }> = []
    const deliveryHolder: { current?: ReturnType<typeof createDownstreamDeliverySession> } = {}
    let scaffoldCalls = 0
    const delivery = createDownstreamDeliverySession({
      sink: arraySink(writes),
      monotonicNow: Date.now,
      heartbeat: {
        intervalMs: 20_000,
        contentDeadlineMs: 200_000,
        frame: () => ({ event: "ping", data: '{"type":"ping"}' }),
        contentFrame: () => ({ event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}' }),
        async injectContentScaffold() {
          scaffoldCalls++
          const current = deliveryHolder.current
          if (!current) throw new Error("delivery not bound")
          await (current.clientSink as OwnerRawSink).writeAnchor?.(frame("content_block_start", 0, "text"))
          await current.clientSink.writeKeepalive?.({
            event: "content_block_delta",
            data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}',
          })
          return true
        },
      },
    })
    deliveryHolder.current = delivery

    for (let elapsed = 0; elapsed < 200_000; elapsed += 20_000) {
      await clock.advance(20_000)
      await drain()
    }
    expect(scaffoldCalls).toBe(1)
    expect(writes.slice(-2).map(({ method }) => method)).toEqual(["anchor", "keepalive"])
    expect(delivery.snapshot.ledger.openBlocks).toEqual([{ index: 0, type: "text", synthetic: true }])
    delivery.clientSink.close?.()
  })

  test("normal envelope scaffold does not suppress later pre-content content scaffold", async () => {
    clock.install()
    const writes: Array<{ method: string; frame: unknown }> = []
    let envelopeCalls = 0
    let contentCalls = 0
    const delivery = createDownstreamDeliverySession({
      sink: arraySink(writes),
      monotonicNow: Date.now,
      heartbeat: {
        intervalMs: 20_000,
        contentDeadlineMs: 200_000,
        frame: () => ({ event: "ping", data: '{"type":"ping"}' }),
        async injectScaffold() {
          envelopeCalls++
          return true
        },
        async injectContentScaffold() {
          contentCalls++
          return true
        },
      },
    })
    for (let elapsed = 0; elapsed < 200_000; elapsed += 20_000) {
      await clock.advance(20_000)
      await drain()
    }
    expect(envelopeCalls).toBe(1)
    expect(contentCalls).toBe(1)
    delivery.clientSink.close?.()
  })

  test("content scaffold is forbidden after any real block completed", async () => {
    clock.install()
    const writes: Array<{ method: string; frame: unknown }> = []
    let scaffoldCalls = 0
    const delivery = createDownstreamDeliverySession({
      sink: arraySink(writes),
      monotonicNow: Date.now,
      heartbeat: {
        intervalMs: 20_000,
        contentDeadlineMs: 200_000,
        frame: () => ({ event: "ping", data: '{"type":"ping"}' }),
        contentFrame: () => ({ event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}' }),
        async injectContentScaffold() {
          scaffoldCalls++
          return true
        },
      },
    })
    await delivery.clientSink.write(frame("content_block_start", 0, "text"))
    await delivery.clientSink.write(frame("content_block_stop", 0))
    expect(delivery.snapshot.ledger.semanticBlockCount).toBe(1)
    writes.length = 0
    for (let elapsed = 0; elapsed < 220_000; elapsed += 20_000) {
      await clock.advance(20_000)
      await drain()
    }
    expect(scaffoldCalls).toBe(0)
    expect(writes.every(({ frame: value }) => (value as { event?: string }).event === "ping")).toBe(true)
    delivery.clientSink.close?.()
  })

  test("contentDeadlineMs=0 leaves ping shape unchanged beyond 300s", async () => {
    clock.install()
    const writes: Array<{ method: string; frame: unknown }> = []
    const delivery = createDownstreamDeliverySession({
      sink: arraySink(writes),
      monotonicNow: Date.now,
      heartbeat: {
        intervalMs: 20_000,
        contentDeadlineMs: 0,
        frame: () => ({ event: "ping", data: '{"type":"ping"}' }),
        contentFrame: () => ({ event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}' }),
      },
    })
    await delivery.clientSink.write(frame("content_block_start", 0, "text"))
    writes.length = 0
    for (let elapsed = 0; elapsed < 320_000; elapsed += 20_000) {
      await clock.advance(20_000)
      await drain()
    }
    expect(writes).toHaveLength(16)
    expect(writes.every(({ frame: value }) => (value as { event?: string }).event === "ping")).toBe(true)
    delivery.clientSink.close?.()
  })

  test("real content delta resets the on-demand escalation deadline", async () => {
    clock.install()
    const writes: Array<{ method: string; frame: unknown }> = []
    const delivery = createDownstreamDeliverySession({
      sink: arraySink(writes),
      monotonicNow: Date.now,
      heartbeat: {
        intervalMs: 20_000,
        contentDeadlineMs: 200_000,
        frame: () => ({ event: "ping", data: '{"type":"ping"}' }),
        contentFrame: () => ({ event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}' }),
      },
    })

    await delivery.clientSink.write(frame("content_block_start", 0, "text"))
    writes.length = 0
    for (let elapsed = 0; elapsed < 180_000; elapsed += 20_000) {
      await clock.advance(20_000)
      await drain()
    }
    await delivery.clientSink.write({
      event: "content_block_delta",
      data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"real"}}',
    })
    for (let elapsed = 0; elapsed < 180_000; elapsed += 20_000) {
      await clock.advance(20_000)
      await drain()
    }
    expect(writes.at(-1)?.frame).toMatchObject({ event: "ping" })
    await clock.advance(20_000)
    await drain()
    expect(writes.at(-1)?.frame).toMatchObject({ event: "content_block_delta" })
    delivery.clientSink.close?.()
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
