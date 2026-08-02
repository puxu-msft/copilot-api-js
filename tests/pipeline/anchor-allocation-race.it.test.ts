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
import {
  //
  assertBlockProtocolState,
  assertMonotonicWireIndices,
} from "../helpers/wire-index-oracle"

const start = (index: number, type = "text"): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type, text: "" } }),
})
const stop = (index: number): ClientFrame => ({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) })

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test("an anchor write parked at the sink cannot interleave with a real-block allocation", async () => {
  const parked = gate()
  const entered = gate()
  const frames: Array<ClientFrame> = []
  let writes = 0
  const sink: ClientSink = {
    async write(frame) {
      frames.push(frame)
    },
    async writeAnchor(frame) {
      frames.push(frame)
      if (++writes === 1) {
        entered.release()
        await parked.promise
      }
    },
    close() {},
  }
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const port = createDownstreamDeliverySession({ sink, wireState }).allocationPort
  ownerValue(await port.beginLeg("primary", { candidateId: "candidate", dispatchId: "dispatch" }))

  const anchor = port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(start(wireIndex)), envelope.anchor(stop(wireIndex))])
  await entered.promise
  const real = port.withAllocatedRealBlock(0, ({ mapping, envelope }) => [envelope.real(mapping.remap(start(0))), envelope.real(mapping.remap(stop(0)))])

  // The anchor reached C9's commit point, but the queued real operation has not reserved anything yet.
  expect(wireState.allocator.nextRealIndex()).toBe(1)
  parked.release()
  expect(ownerValue(await anchor)).toBe(0)
  expect(ownerValue(await real).wireIndex).toBe(1)
  assertMonotonicWireIndices(frames)
  assertBlockProtocolState(frames)
})

test("POSITIVE CONTROL: allocating outside the serializer creates a duplicate wire index", () => {
  let frontier = 0
  const illegalPeek = (): number => frontier
  const illegalCommit = (): void => void frontier++
  const anchorIndex = illegalPeek()
  const realIndex = illegalPeek()
  illegalCommit()
  illegalCommit()
  const bad = [start(anchorIndex), stop(anchorIndex), start(realIndex), stop(realIndex)]

  expect(() => assertMonotonicWireIndices(bad)).toThrow("expected 1")
})
