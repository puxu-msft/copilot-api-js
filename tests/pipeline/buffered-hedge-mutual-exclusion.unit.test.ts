import { describe, expect, test } from "bun:test"

import { makeArraySink } from "~/lib/pipeline/client-sink"
import { createPipelineDriver } from "~/lib/pipeline/driver"
import { createFrozenHedgePolicy } from "~/lib/pipeline/generation/hedge-policy"

import { makeBufferedHarness } from "./helpers/buffered-harness"

describe("buffered ⊥ hedge mutual exclusion (spec §5.4, 2026-07-19 新增不变量)", () => {
  // NOTE (执行期坐实 — plan 的 mutation 预测已修正): `maybeRunHedgedResponseSink` 有一条更早的前置守卫
  // `if (!policy?.enabled || !runtime || !binding || !env.stream) return undefined`（driver.ts）。
  // `makeBufferedHarness` 不建立 generation binding，故 `!binding` 首先短路 → 单注释掉 retryCap 短路
  // (driver.ts:769) 不会让本测试变红（那行在此 harness 从未被触达）。**生产路径**有 binding，retryCap
  // 短路才是承重守卫。因此本测试是端到端 characterization（hedge-enabled 驱动下 buffered 仍走自己的
  // 顺序循环、产出正确顺序、不被任何 hedge winner-selection 改写），而非对 retryCap 短路的隔离。真正
  // 隔离 retryCap 短路的 teeth-ful 测试需要 binding-present harness — 见 handover backlog（低优先，
  // 不变量由 binding-absence + retryCap 双重防御保证）。
  test("a hedge-enabled driver runs the buffered sink's own sequential path (never a hedge race) when opts carries retryCap", async () => {
    const frames = [{ event: "response.created", data: JSON.stringify({ type: "response.created" }) }, { event: "response.completed", data: JSON.stringify({ type: "response.completed" }) }]
    const h = makeBufferedHarness(frames, { sawMessageStop: true })
    const { sink, frames: written } = makeArraySink()
    const policy = createFrozenHedgePolicy({
      enabled: true,
      thresholdMs: 0,
      maxSecondaryCandidates: 1,
      maxActiveCandidates: 2,
      maxTotalCandidates: 3,
      maxActiveDispatches: 2,
      maxTotalDispatches: 4,
      cleanupMarginMs: 0,
      responseHeaderTimeoutMs: 0,
      requestDeadlineAtMs: 0,
      expectedHedgeCompletionMs: 1,
    })
    const driver = createPipelineDriver({ ...h.deps, hedgePolicy: policy })
    const outcome = await driver.runResponseBufferedSink(h.upstream, h.env, sink, { ...h.opts, sawMessageStop: () => true, retryCap: 1 })
    expect(outcome.kind).toBe("complete")
    // The buffered sink's own frames (unmodified by any hedge winner-selection path) reached the sink
    // directly — a hedge race would route frames through writeWinnerFrames, not this verbatim order.
    expect(written.map((f) => f.event)).toEqual(["response.created", "response.completed"])
  })
})
