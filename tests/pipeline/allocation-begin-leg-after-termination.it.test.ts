/**
 * `beginLeg` 在【已终止的 delivery】上的行为 —— CHARACTERIZATION（记录现状，不是宣告契约）。
 *
 * 背景：C9 的 commit-point 语义规定「session 拒绝 → 零副作用」，Task 2.2c 的 oracle 也只写了
 * 「a session refusal allocates nothing」。owner 的其余三个入口（`allocateAndWriteAnchor` /
 * `withAllocatedRealBlock` / `writeBlockFrame`）在 session 非 open 时都【安静返回】
 * （`undefined` / `"write-error"`）；只有 `beginLeg` 会【抛出】。
 *
 * 这条不对称本身可能是有意的（fail loud），但它现在有生产消费者：`driver.ts` 的四个
 * `await allocationPort.beginLeg(...)` 站点（primary ×2 / recovery / continuation）都没有 try/catch，
 * 而 `terminateAfterWireFailure()`（anchor 帧写失败，例如客户端中途断开）会把 session 置为
 * `closed`。也就是说「pre-response anchor 写失败 → 上游随后返回 → driver 进入 → beginLeg 抛错」
 * 这条链路在 P2 之后从『安静走完』变成了『从 driver 抛出』。
 *
 * 本文件只钉住 owner 层的事实，把契约裁决交回主会话：若「拒绝即抛」是想要的语义，driver 站点需要
 * 显式处理；若「安静拒绝」才是，`beginLeg` 应与三个同侪一致。
 */

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
import { StreamClientAbortError } from "~/lib/stream"

const start = (index: number): ClientFrame => ({
  event: "content_block_start",
  data: JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
})

const PRIMARY = { candidateId: "candidate-primary", dispatchId: "dispatch-primary" }
const RECOVERY = { candidateId: "candidate-recovery", dispatchId: "dispatch-recovery" }

test("all owner entries return delivery-finished after a wire failure closes the session", async () => {
  const sink: OwnerRawSink = {
    write: async () => {
      throw new StreamClientAbortError()
    },
    writeAnchor: async () => {
      throw new StreamClientAbortError()
    },
    close() {},
  }
  let finalized = 0
  sink.finalize = async () => {
    finalized++
  }
  const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
  const delivery = createDownstreamDeliverySession({ sink, wireState })
  const port = delivery.allocationPort
  const primary = await port.beginLeg("primary", PRIMARY)
  if (!primary.ok) throw new Error("primary leg unexpectedly rejected")

  // 一次失败的 anchor 写出（= 客户端中途断开）走 terminateAfterWireFailure → state = "closed"。
  expect(await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(start(wireIndex))])).toEqual({
    ok: false,
    reason: "client-gone",
    committed: true,
  })
  expect(delivery.snapshot.state).toBe("closed")

  expect(await port.allocateAndWriteAnchor(({ wireIndex, envelope }) => [envelope.anchor(start(wireIndex))])).toEqual({
    ok: false,
    reason: "client-gone",
    committed: false,
  })
  expect(await port.withAllocatedRealBlock(0, ({ mapping, envelope }) => [envelope.real(mapping.remap(start(0)))])).toEqual({
    ok: false,
    reason: "client-gone",
    committed: false,
  })
  expect(await port.writeBlockFrame(primary.value, 0, start(0))).toEqual({ ok: false, reason: "client-gone", committed: false })
  expect(await port.beginLeg("recovery", RECOVERY)).toEqual({ ok: false, reason: "client-gone", committed: false })
  expect(await port.closeOpenAnchor((index, envelope) => envelope.anchor(start(index)), "terminal")).toEqual({
    ok: false,
    reason: "client-gone",
    committed: false,
  })
  expect(finalized).toBe(1)
  await delivery.terminate({ kind: "client-aborted" })
  expect(finalized).toBe(1)
})
