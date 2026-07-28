import {
  //
  expect,
  test,
} from "bun:test"

import type { ClientFrame, ClientSink } from "~/lib/pipeline/types"

import {
  //
  createGenerationWireIndexAllocator,
  createGenerationWireState,
} from "~/lib/anthropic/keepalive-anchor"
import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"

const start = (index: number, type = "text"): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type, text: "" } }),
})

function setup() {
  const writes: Array<ClientFrame> = []
  const sink: ClientSink = {
    async write(frame) {
      writes.push(frame)
    },
    async writeAnchor(frame) {
      writes.push(frame)
    },
    close() {},
  }
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const delivery = createDownstreamDeliverySession({ sink, wireState })
  return { writes, wireState, port: delivery.allocationPort }
}

test("an allocated-but-unwritten mapping is invisible inside its build callback", async () => {
  const { wireState, port } = setup()
  const leg = await port.beginLeg("primary", { candidateId: "candidate-primary", dispatchId: "dispatch-primary" })

  const mapping = await port.withAllocatedRealBlock(0, ({ mapping: allocated, envelope }) => {
    expect(wireState.mappings.get(leg)?.get(0)).toBeUndefined()
    return [envelope.real(allocated.remap(start(0)))]
  })

  expect(wireState.mappings.get(leg)?.get(0)).toBe(mapping)
})

test("recovery with no prior anchor maps upstream 0 to wire 0 by identity", async () => {
  const { writes, port } = setup()
  const recovery = await port.beginLeg("recovery", { candidateId: "candidate-recovery", dispatchId: "dispatch-recovery" })
  const frame = start(0)
  const mapping = await port.withAllocatedRealBlock(0, ({ mapping: allocated, envelope }) => {
    const remapped = allocated.remap(frame)
    expect(remapped).toBe(frame)
    return [envelope.real(remapped)]
  })

  expect(mapping?.leg).toBe(recovery)
  expect(mapping?.wireIndex).toBe(0)
  expect(writes[0]).toBe(frame)
})

test("recovery after a pre-content anchor maps upstream 0 to wire 1", async () => {
  const { writes, port } = setup()
  expect(await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(start(wireIndex))])).toBe(0)
  const recovery = await port.beginLeg("recovery", { candidateId: "candidate-recovery", dispatchId: "dispatch-recovery" })
  const frame = start(0)
  const mapping = await port.withAllocatedRealBlock(0, ({ mapping: allocated, envelope }) => [envelope.real(allocated.remap(frame))])

  expect(mapping?.leg).toBe(recovery)
  expect(mapping?.wireIndex).toBe(1)
  expect(JSON.parse(writes.at(-1)!.data as string).index).toBe(1)
  expect(writes.at(-1)).not.toBe(frame)
})
