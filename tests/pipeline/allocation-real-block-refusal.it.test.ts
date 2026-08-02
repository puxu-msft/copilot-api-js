/**
 * C9 档 1（commit point 之前 → 零副作用、全回滚）在 REAL BLOCK 腿上的 oracle。
 *
 * 已有的 commit-point 套件（`allocation-commit-point.it.test.ts` / `anchor-allocation-owner.it.test.ts`）
 * 只对 `allocateAndWriteAnchor` 断言了这两条；`withAllocatedRealBlock` 与 `writeBlockFrame` 的
 * 「build 抛错 → 全回滚」「session 已拒绝 → 零分配」两条完全没有门。实测：把
 * `withAllocatedRealBlock` 的 `reservation.rollback()` 改成 `reservation.commit()`、或删掉它的
 * `if (state !== "open") return undefined` 守卫，标准档 6550 tests 全绿——两处生产代码可以静默反向。
 *
 * 本文件补的正是这两格。C9 的两段语义在 anchor 腿上已被双向 mutation 证明有门；real 腿此前只有实现。
 */

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

const start = (index: number): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
})
const delta = (index: number): ClientFrame => ({
  event: "content_block_delta",
  data: JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text: "x" } }),
})
const stop = (index: number): ClientFrame => ({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) })

function setupWithSink(sink: ClientSink) {
  const writes: Array<ClientFrame> = []
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const delivery = createDownstreamDeliverySession({ sink, wireState })
  return { writes, wireState, delivery, port: delivery.allocationPort }
}

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
  return { writes, wireState, delivery, port: delivery.allocationPort }
}

const PRIMARY = { candidateId: "candidate-primary", dispatchId: "dispatch-primary" }

test("a REAL-block build callback throwing before any wire write rolls back the whole reservation", async () => {
  const { writes, wireState, port } = setup()
  const leg = ownerValue(await port.beginLeg("primary", PRIMARY))

  await expect(
    port.withAllocatedRealBlock(0, () => {
      throw new Error("real build failed")
    }),
  ).rejects.toThrow("real build failed")

  // 零外部副作用 → 预留对读者不可见 → frontier / mapping / wire 全不动。
  expect(writes).toEqual([])
  expect(wireState.allocator.nextRealIndex()).toBe(0)
  expect(wireState.mappings.get(leg)?.get(0)).toBeUndefined()

  // 反向证明：回滚后的下一次分配必须拿到【同一个】index（否则就是跳号）。
  const mapping = ownerValue(await port.withAllocatedRealBlock(0, ({ mapping: allocated, envelope }) => [envelope.real(allocated.remap(start(0)))]))
  expect(mapping?.wireIndex).toBe(0)
})

test("a REAL-block build throw does not wedge the allocator for the NEXT anchor either", async () => {
  const { wireState, port } = setup()
  ownerValue(await port.beginLeg("primary", PRIMARY))
  await expect(
    port.withAllocatedRealBlock(0, () => {
      throw new Error("real build failed")
    }),
  ).rejects.toThrow("real build failed")

  // reservationOpen 未复位会让后续任何分配抛 "reservation already open"。
  expect(ownerValue(await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(start(wireIndex))]))).toBe(0)
  expect(wireState.allocator.anchorsOpened()).toBe(1)
})

test("a terminated session refuses a REAL-block allocation without allocating or writing", async () => {
  const { writes, wireState, delivery, port } = setup()
  const leg = ownerValue(await port.beginLeg("primary", PRIMARY))
  await delivery.terminate({ kind: "client-aborted" })

  expect(await port.withAllocatedRealBlock(0, ({ mapping, envelope }) => [envelope.real(mapping.remap(start(0)))])).toEqual({
    ok: false,
    reason: "delivery-finished",
  })
  expect(writes).toEqual([])
  expect(wireState.allocator.nextRealIndex()).toBe(0)
  expect(wireState.mappings.get(leg)?.get(0)).toBeUndefined()
})

test("a REAL-block first-write abort consumes the mapping and terminates delivery", async () => {
  const sink: ClientSink = {
    async write() {
      throw new StreamClientAbortError()
    },
    close() {},
  }
  const { wireState, delivery, port } = setupWithSink(sink)
  const leg = ownerValue(await port.beginLeg("primary", PRIMARY))

  expect(await port.withAllocatedRealBlock(0, ({ mapping, envelope }) => [envelope.real(mapping.remap(start(0)))])).toEqual({
    ok: false,
    reason: "delivery-finished",
  })
  expect(wireState.allocator.nextRealIndex()).toBe(1)
  expect(wireState.mappings.get(leg)?.get(0)?.wireIndex).toBe(0)
  expect(delivery.snapshot.state).toBe("closed")
})

test("a REAL-block build success followed by a second-frame abort never reuses the visible mapping", async () => {
  let writes = 0
  const sink: ClientSink = {
    async write() {
      if (++writes === 2) throw new StreamClientAbortError()
    },
    close() {},
  }
  const { wireState, delivery, port } = setupWithSink(sink)
  const leg = ownerValue(await port.beginLeg("primary", PRIMARY))

  expect(
    await port.withAllocatedRealBlock(0, ({ mapping, envelope }) => [envelope.real(mapping.remap(start(0))), envelope.real(mapping.remap(delta(0)))]),
  ).toEqual({ ok: false, reason: "delivery-finished" })
  expect(wireState.allocator.nextRealIndex()).toBe(1)
  expect(wireState.mappings.get(leg)?.get(0)?.wireIndex).toBe(0)
  expect(delivery.snapshot.state).toBe("closed")
})

test("writeBlockFrame abort preserves mapping and terminates delivery", async () => {
  const sink: ClientSink = {
    async write(frame) {
      if (JSON.parse(frame.data ?? "{}").type === "content_block_stop") throw new StreamClientAbortError()
    },
    close() {},
  }
  const { wireState, delivery, port } = setupWithSink(sink)
  const leg = ownerValue(await port.beginLeg("primary", PRIMARY))
  const mapping = ownerValue(await port.withAllocatedRealBlock(0, ({ mapping: allocated, envelope }) => [envelope.real(allocated.remap(start(0)))]))

  expect(await port.writeBlockFrame(leg, 0, stop(0))).toEqual({ ok: false, reason: "delivery-finished" })
  expect(wireState.mappings.get(leg)?.get(0)).toBe(mapping)
  expect(delivery.snapshot.state).toBe("closed")
})

test("writeBlockFrame non-client errors terminate delivery and remain visible", async () => {
  const sink: ClientSink = {
    async write(frame) {
      if (JSON.parse(frame.data ?? "{}").type === "content_block_delta") throw new Error("sink wiring failed")
    },
    close() {},
  }
  const { wireState, delivery, port } = setupWithSink(sink)
  const leg = ownerValue(await port.beginLeg("primary", PRIMARY))
  await port.withAllocatedRealBlock(0, ({ mapping: allocated, envelope }) => [envelope.real(allocated.remap(start(0)))])

  await expect(port.writeBlockFrame(leg, 0, delta(0))).rejects.toThrow("sink wiring failed")
  expect(wireState.mappings.get(leg)?.has(0)).toBe(true)
  expect(delivery.snapshot.state).toBe("closed")
})

test("a terminated session refuses writeBlockFrame instead of emitting an unremapped frame", async () => {
  const { writes, wireState, delivery, port } = setup()
  const anchor = ownerValue(await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(start(wireIndex))]))
  expect(anchor).toBe(0)
  const leg = ownerValue(await port.beginLeg("primary", PRIMARY))
  const mapping = ownerValue(await port.withAllocatedRealBlock(0, ({ mapping: allocated, envelope }) => [envelope.real(allocated.remap(start(0)))]))
  expect(mapping?.wireIndex).toBe(1)
  const writesBefore = writes.length

  await delivery.terminate({ kind: "client-aborted" })

  expect(await port.writeBlockFrame(leg, 0, delta(0))).toEqual({ ok: false, reason: "delivery-finished" })
  expect(writes).toHaveLength(writesBefore)
  // 拒绝不得吃掉 mapping —— 释放只在 stop 成功写出后发生（C10 ③）。
  expect(wireState.mappings.get(leg)?.get(0)).toBe(mapping)
})
