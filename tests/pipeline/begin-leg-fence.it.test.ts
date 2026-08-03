import {
  //
  expect,
  test,
} from "bun:test"

import type { OwnerRawSink } from "~/lib/pipeline/delivery/types"
import type {
  //
  ClientFrame,
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
const delta = (index: number): ClientFrame => ({
  event: "content_block_delta",
  data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text: "x" } }),
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function setup(sink: OwnerRawSink) {
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const port = createDownstreamDeliverySession({ sink, wireState }).allocationPort
  return { wireState, port }
}

test("beginLeg fences after previous queued writes and before next-leg allocations", async () => {
  const order: Array<string> = []
  const entered = deferred()
  const release = deferred()
  const sink: OwnerRawSink = {
    async write(frame) {
      const payload = JSON.parse(frame.data as string) as { type: string; index: number }
      order.push(`write:${payload.type}@${payload.index}`)
      if (payload.type === "content_block_delta") {
        entered.resolve()
        await release.promise
      }
    },
    close() {},
  }
  const { wireState, port } = setup(sink)
  const primary = ownerValue(await port.beginLeg("primary", { candidateId: "candidate-primary", dispatchId: "dispatch-primary" }))
  ownerValue(await port.withAllocatedRealBlock(0, ({ mapping, envelope }) => [envelope.real(mapping.remap(start(0)))]))

  const priorWrite = port.writeBlockFrame(primary, 0, delta(0))
  await entered.promise
  const continuationFence = port.beginLeg("continuation", { candidateId: "candidate-cont", dispatchId: "dispatch-cont" })
  const nextAllocation = port.withAllocatedRealBlock(0, ({ mapping, envelope }) => {
    order.push(`allocate:${mapping.wireIndex}`)
    return [envelope.real(mapping.remap(start(0)))]
  })
  expect(wireState.activeLeg?.token).toBe(primary)
  release.resolve()

  expect(ownerValue(await priorWrite)).toBe("written")
  const continuation = ownerValue(await continuationFence)
  expect(ownerValue(await nextAllocation).leg).toBe(continuation)
  expect(order).toEqual(["write:content_block_start@0", "write:content_block_delta@0", "allocate:1", "write:content_block_start@1"])
})

test("anchor-before-begin and begin-before-anchor both preserve submission order", async () => {
  for (const orderKind of ["anchor-first", "begin-first"] as const) {
    const order: Array<string> = []
    const sink: OwnerRawSink = {
      async write(frame) {
        order.push(JSON.parse(frame.data as string).type)
      },
      async writeAnchor(frame) {
        order.push(JSON.parse(frame.data as string).type)
      },
      close() {},
    }
    const { port } = setup(sink)
    const anchor = () => port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(start(wireIndex))])
    const begin = () => port.beginLeg("primary", { candidateId: "candidate-primary", dispatchId: "dispatch-primary" })

    const first = orderKind === "anchor-first" ? anchor() : begin()
    const second = orderKind === "anchor-first" ? begin() : anchor()
    await first
    await second
    const mapping = ownerValue(await port.withAllocatedRealBlock(0, ({ mapping: allocated, envelope }) => [envelope.real(allocated.remap(start(0)))]))

    expect(mapping?.wireIndex).toBe(1)
    expect(order).toEqual(["content_block_start", "content_block_start"])
  }
})
