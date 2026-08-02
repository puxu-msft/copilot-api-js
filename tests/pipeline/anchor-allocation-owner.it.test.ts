import {
  //
  expect,
  test,
} from "bun:test"

import type {
  //
  ClientFrame,
  ClientSink,
} from "~/lib/pipeline/types"

import {
  //
  createGenerationWireIndexAllocator,
  createGenerationWireState,
} from "~/lib/anthropic/keepalive-anchor"
import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import { StreamClientAbortError } from "~/lib/stream"

import { ownerValue } from "../helpers/owner-result"

const anchorStart = (index: number): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
})
const anchorDelta = (index: number): ClientFrame => ({
  event: "content_block_delta",
  data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text: "" } }),
})
const anchorStop = (index: number): ClientFrame => ({
  event: "content_block_stop",
  data: JSON.stringify({ type: "content_block_stop", index }),
})
const realStart = (index: number): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }),
})

function recordingSink(writes: Array<{ method: string; frame: ClientFrame }>): ClientSink {
  return {
    write: async (frame) => void writes.push({ method: "real", frame }),
    writeAnchor: async (frame) => void writes.push({ method: "anchor", frame }),
    writeKeepalive: async (frame) => void writes.push({ method: "keepalive", frame }),
    close() {},
  }
}

function setup(sink?: ClientSink) {
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const writes: Array<{ method: string; frame: ClientFrame }> = []
  const delivery = createDownstreamDeliverySession({ sink: sink ?? recordingSink(writes), wireState })
  return { wireState, writes, delivery, port: delivery.allocationPort }
}

test("anchor and following real allocation preserve frontier order", async () => {
  const { port, wireState, writes } = setup()
  const leg = ownerValue(await port.beginLeg("primary", { candidateId: "candidate-primary", dispatchId: "dispatch-primary" }))
  expect(wireState.activeLeg?.token).toBe(leg)

  expect(
    ownerValue(
      await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(anchorStart(wireIndex)), envelope.keepalive(anchorDelta(wireIndex))]),
    ),
  ).toBe(0)
  const mapping = ownerValue(await port.withAllocatedRealBlock(0, ({ mapping: allocated, envelope }) => [envelope.real(allocated.remap(realStart(0)))]))

  expect(mapping?.wireIndex).toBe(1)
  expect(writes.map(({ method, frame }) => `${method}@${JSON.parse(frame.data as string).index}`)).toEqual(["anchor@0", "keepalive@0", "real@1"])
})

test("build failure before the first write rolls back the frontier", async () => {
  const { port, wireState } = setup()
  await expect(
    port.allocateAndWriteAnchor(() => {
      throw new Error("build failed")
    }),
  ).rejects.toThrow("build failed")
  expect(wireState.allocator.nextAnchorIndex()).toBe(0)
  expect(wireState.allocator.anchorsOpened()).toBe(0)
})

test("first attempted write consumes the index and terminates delivery on failure", async () => {
  const sink: ClientSink = {
    write: async () => {
      throw new StreamClientAbortError()
    },
    writeAnchor: async () => {
      throw new StreamClientAbortError()
    },
    close() {},
  }
  const { port, wireState, delivery } = setup(sink)
  expect(await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(anchorStart(wireIndex))])).toEqual({
    ok: false,
    reason: "client-gone",
    committed: true,
  })
  expect(wireState.allocator.nextAnchorIndex()).toBe(1)
  expect(delivery.snapshot.state).toBe("closed")
  expect(await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(anchorStart(wireIndex))])).toEqual({
    ok: false,
    reason: "client-gone",
    committed: true,
  })
})

test("primary, recovery, and continuation legs retain distinct real provenance", async () => {
  const { port, wireState } = setup()
  const sources = [
    { kind: "primary" as const, candidateId: "candidate-primary", dispatchId: "dispatch-primary" },
    { kind: "recovery" as const, candidateId: "candidate-recovery", dispatchId: "dispatch-recovery" },
    { kind: "continuation" as const, candidateId: "candidate-cont", dispatchId: "dispatch-cont" },
  ]
  const legs = []
  for (const source of sources) {
    const leg = ownerValue(await port.beginLeg(source.kind, source))
    const mapping = ownerValue(await port.withAllocatedRealBlock(0, ({ mapping: allocated, envelope }) => [envelope.real(allocated.remap(realStart(0)))]))
    expect(mapping?.leg).toBe(leg)
    expect(wireState.legSources.get(leg)).toEqual({ candidateId: source.candidateId, dispatchId: source.dispatchId })
    legs.push(leg)
  }
  expect(new Set(legs).size).toBe(3)
  expect(wireState.legSources.get(legs[0])).not.toEqual(wireState.legSources.get(legs[2]))
})

test("real allocation without beginLeg is rejected rather than degraded", async () => {
  const { port, wireState } = setup()
  await expect(port.withAllocatedRealBlock(0, ({ mapping, envelope }) => [envelope.real(mapping.remap(realStart(0)))])).rejects.toThrow("active leg")
  expect(wireState.allocator.nextRealIndex()).toBe(0)
})

test("a pre-commit envelope wiring error rolls back the anchor reservation", async () => {
  const { port, wireState } = setup()
  await expect(port.allocateAndWriteAnchor(({ envelope }) => [envelope.real(realStart(0))])).rejects.toThrow("active leg")
  expect(wireState.allocator.nextAnchorIndex()).toBe(0)
  expect(wireState.allocator.anchorsOpened()).toBe(0)
})

test("handler anchor state and delivery port share the exact GenerationWireState reference", () => {
  const { wireState, delivery, port } = setup()
  expect(port.wireState).toBe(wireState)
  expect(delivery.allocationPort).toBe(port)
  expect(port.wireState?.allocator).toBe(wireState.allocator)
})

test("closeOpenAnchor passes the allocated index explicitly and is idempotent", async () => {
  const { wireState, writes, port } = setup()
  expect(ownerValue(await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(anchorStart(wireIndex))]))).toBe(0)
  const seen: Array<number> = []

  expect(
    ownerValue(
      await port.closeOpenAnchor((index, envelope) => {
        seen.push(index)
        return envelope.anchor(anchorStop(index))
      }, "before-real"),
    ),
  ).toBe("closed")
  expect(ownerValue(await port.closeOpenAnchor((index, envelope) => envelope.anchor(anchorStop(index)), "before-real"))).toBe("none")
  expect(seen).toEqual([0])
  expect(wireState.openAnchorIndex).toBeUndefined()
  expect(writes.map(({ frame }) => JSON.parse(frame.data as string).type)).toEqual(["content_block_start", "content_block_stop"])
})
