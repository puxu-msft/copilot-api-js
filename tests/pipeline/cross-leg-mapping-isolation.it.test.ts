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

import { ownerValue } from "../helpers/owner-result"

const start = (index: number): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
})
const delta = (index: number, text: string): ClientFrame => ({
  event: "content_block_delta",
  data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
})
const stop = (index: number): ClientFrame => ({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) })

function setup() {
  const writes: Array<ClientFrame> = []
  const sink: ClientSink = {
    async write(frame) {
      writes.push(frame)
    },
    close() {},
  }
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const port = createDownstreamDeliverySession({ sink, wireState }).allocationPort
  return { writes, wireState, port }
}

function indexes(frames: ReadonlyArray<ClientFrame>): Array<number> {
  return frames.map((frame) => JSON.parse(frame.data as string).index as number)
}

test("the same upstream index on two legs resolves through each explicit leg token", async () => {
  const { writes, wireState, port } = setup()
  const primary = ownerValue(await port.beginLeg("primary", { candidateId: "candidate-primary", dispatchId: "dispatch-primary" }))
  const primaryMapping = ownerValue(await port.withAllocatedRealBlock(0, ({ mapping, envelope }) => [envelope.real(mapping.remap(start(0)))]))
  const continuation = ownerValue(await port.beginLeg("continuation", { candidateId: "candidate-cont", dispatchId: "dispatch-cont" }))
  const continuationMapping = ownerValue(await port.withAllocatedRealBlock(0, ({ mapping, envelope }) => [envelope.real(mapping.remap(start(0)))]))

  expect(primaryMapping?.wireIndex).toBe(0)
  expect(continuationMapping?.wireIndex).toBe(1)
  expect(ownerValue(await port.writeBlockFrame(primary, 0, delta(0, "primary")))).toBe("written")
  expect(ownerValue(await port.writeBlockFrame(continuation, 0, delta(0, "continuation")))).toBe("written")
  expect(ownerValue(await port.writeBlockFrame(primary, 0, stop(0)))).toBe("written")
  expect(ownerValue(await port.writeBlockFrame(continuation, 0, stop(0)))).toBe("written")

  expect(indexes(writes)).toEqual([0, 1, 0, 1, 0, 1])
  expect(wireState.mappings.get(primary)?.has(0)).toBe(false)
  expect(wireState.mappings.get(continuation)?.has(0)).toBe(false)
})

test("a stale leg token still resolves its own block after a newer leg opens", async () => {
  const { writes, port } = setup()
  const primary = ownerValue(await port.beginLeg("primary", { candidateId: "candidate-primary", dispatchId: "dispatch-primary" }))
  ownerValue(await port.withAllocatedRealBlock(0, ({ mapping, envelope }) => [envelope.real(mapping.remap(start(0)))]))
  ownerValue(await port.beginLeg("continuation", { candidateId: "candidate-cont", dispatchId: "dispatch-cont" }))
  ownerValue(await port.withAllocatedRealBlock(0, ({ mapping, envelope }) => [envelope.real(mapping.remap(start(0)))]))

  expect(ownerValue(await port.writeBlockFrame(primary, 0, delta(0, "late-primary")))).toBe("written")
  expect(indexes(writes).at(-1)).toBe(0)
})

test("missing mapping is explicit and never writes the original frame", async () => {
  const { writes, port } = setup()
  const primary = ownerValue(await port.beginLeg("primary", { candidateId: "candidate-primary", dispatchId: "dispatch-primary" }))
  const orphan = delta(0, "orphan")

  expect(await port.writeBlockFrame(primary, 0, orphan)).toEqual({ ok: false, reason: "no-mapping", committed: false })
  expect(writes).toEqual([])
})

test("one leg can retain multiple block mappings concurrently", async () => {
  const { wireState, port } = setup()
  const primary = ownerValue(await port.beginLeg("primary", { candidateId: "candidate-primary", dispatchId: "dispatch-primary" }))
  ownerValue(await port.withAllocatedRealBlock(0, ({ mapping, envelope }) => [envelope.real(mapping.remap(start(0)))]))
  ownerValue(await port.withAllocatedRealBlock(1, ({ mapping, envelope }) => [envelope.real(mapping.remap(start(1)))]))

  expect([...wireState.mappings.get(primary)!.keys()]).toEqual([0, 1])
})
