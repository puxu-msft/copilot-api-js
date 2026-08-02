/**
 * 队列外分配的 POSITIVE CONTROL —— 打在【真实 delivery session】上，不是内联假 frontier。
 *
 * `anchor-allocation-race.it.test.ts` 里那条名为 "POSITIVE CONTROL" 的用例，实际只是把手工造的
 * `[start@0, stop@0, start@0, stop@0]` 数组喂给 `assertMonotonicWireIndices` 断言它抛错——它证明的是
 * **matcher 会抛**，不是**这套 harness 能咬住真实的队列外分配**。plan Task 2.2 Step 1 要求的是
 * 「注入一个『先 allocate，再分别 write』的 fake owner，断言上面的 oracle 会红」。本文件补上那一格：
 * 违规动作打在真 session / 真 sink 上，产出的帧序被同一个 oracle 判红。
 *
 * 这也是 C5「分配与写出必须同一个 serializer operation」唯一的反例锁：把违规形状真正跑出来，
 * 才知道合法形状的绿是有裁决力的绿。
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

import { ownerValue } from "../helpers/owner-result"
import {
  //
  assertBlockProtocolState,
  assertMonotonicWireIndices,
} from "../helpers/wire-index-oracle"

const start = (index: number): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
})
const stop = (index: number): ClientFrame => ({ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index }) })

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function setup(sink: ClientSink) {
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const delivery = createDownstreamDeliverySession({ sink, wireState })
  return { wireState, delivery, port: delivery.allocationPort }
}

const PRIMARY = { candidateId: "candidate-primary", dispatchId: "dispatch-primary" }

test("POSITIVE CONTROL on the REAL session: a peek-then-write anchor outside the owner duplicates a wire index the oracle rejects", async () => {
  const frames: Array<ClientFrame> = []
  const sink: ClientSink = {
    async write(frame) {
      frames.push(frame)
    },
    async writeAnchor(frame) {
      frames.push(frame)
    },
    close() {},
  }
  const { wireState, delivery, port } = setup(sink)
  ownerValue(await port.beginLeg("primary", PRIMARY))

  // 非法形状：直接向 allocator peek 一个 index，然后用【另外的】write 调用把帧发出去，
  // 从不 commit —— 正是架构守卫禁止的 "队列外分配 + 两个 operation"。
  const stolen = wireState.allocator.nextAnchorIndex()
  await delivery.clientSink.writeAnchor!(start(stolen))
  await delivery.clientSink.writeAnchor!(stop(stolen))

  // 合法的 owner 分配随后拿到【同一个】index —— frontier 从没被非法路径推进过。
  const mapping = ownerValue(
    await port.withAllocatedRealBlock(0, ({ mapping: allocated, envelope }) => [
      envelope.real(allocated.remap(start(0))),
      envelope.real(allocated.remap(stop(0))),
    ]),
  )
  expect(mapping?.wireIndex).toBe(stolen)

  // 客户端轨上出现两个 index 0 的块 —— O-1 必须判红。
  expect(() => assertMonotonicWireIndices(frames)).toThrow("expected 1")
  // 协议状态机本身看不出重号（两块都规规矩矩地开-关），所以 O-2 单独不足以充当这条门。
  expect(() => assertBlockProtocolState(frames)).not.toThrow()
})

test("POSITIVE CONTROL on the REAL session: an out-of-owner allocation interleaved with a parked owner write also lands a duplicate", async () => {
  const parked = gate()
  const entered = gate()
  const frames: Array<ClientFrame> = []
  let anchorWrites = 0
  const sink: ClientSink = {
    async write(frame) {
      frames.push(frame)
    },
    async writeAnchor(frame) {
      frames.push(frame)
      if (++anchorWrites === 1) {
        entered.release()
        await parked.promise
      }
    },
    close() {},
  }
  const { wireState, delivery, port } = setup(sink)
  ownerValue(await port.beginLeg("primary", PRIMARY))

  const legal = port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(start(wireIndex)), envelope.anchor(stop(wireIndex))])
  await entered.promise

  // 在飞的 owner operation 已过 C9 commit point，但一个队列外的读者仍会拿到【错误的】旧值吗？
  // 不会 —— reservation 在首帧写出前就同步消费了 index，这正是 C9 的目的。
  expect(wireState.allocator.nextAnchorIndex()).toBe(1)

  // 但如果调用方自己保存了一个更早 peek 的 index（TOCTOU 的实际形状），重号照样发生，
  // 且必须被 O-1 咬住 —— 这条正样本证明 harness 收集到的帧确实覆盖了违规窗口。
  const stalePeek = 0
  parked.release()
  expect(ownerValue(await legal)).toBe(0)
  await delivery.clientSink.writeAnchor!(start(stalePeek))
  await delivery.clientSink.writeAnchor!(stop(stalePeek))

  expect(() => assertMonotonicWireIndices(frames)).toThrow()
})
