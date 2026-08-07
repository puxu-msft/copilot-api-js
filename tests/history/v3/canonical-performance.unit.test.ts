import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"

import {
  //
  highBranchFixture,
  largeSseFixture,
  longConversationFixture,
} from "./performance-fixtures"

function median(values: Array<number>): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function measured<T>(factory: () => T, repetitions = 5): { value: T; medianMs: number } {
  const samples: Array<number> = []
  let value = factory()
  for (let index = 0; index < repetitions; index++) {
    const start = performance.now()
    value = factory()
    samples.push(performance.now() - start)
  }
  return { value, medianMs: median(samples) }
}

function heapDelta(factory: () => unknown): number {
  Bun.gc(true)
  const before = process.memoryUsage().heapUsed
  const retained = factory()
  Bun.gc(true)
  const after = process.memoryUsage().heapUsed
  expect(retained).toBeDefined()
  return Math.max(0, after - before)
}

describe("History V3 canonical capture performance", () => {
  test("completes representative workloads within the merge safety budget and reports CPU and heap", () => {
    const startedAt = performance.now()
    const workloads = [
      ["long-conversation", () => longConversationFixture()],
      ["high-branch", () => highBranchFixture()],
      ["large-sse", () => largeSseFixture()],
    ] as const
    const rows = workloads.map(([name, factory]) => {
      const { value, medianMs } = measured(factory)
      const heapBytes = heapDelta(factory)
      return {
        name,
        medianMs,
        heapBytes,
        logicalBytes: Buffer.byteLength(JSON.stringify(value)),
        nodes: value.arena.payloads.length + value.arena.frames.length,
      }
    })
    const totalMs = performance.now() - startedAt

    console.log("HISTORY_V3_PERF canonical", JSON.stringify({ totalMs, rows }))
    expect(totalMs).toBeLessThan(10_000)
    for (const row of rows) {
      expect(row.logicalBytes).toBeGreaterThan(1_000)
      expect(row.nodes).toBeGreaterThan(1)
    }
  }, 15_000)

  test("unchanged upstream, rewrite, and client frames share exactly one arena node", () => {
    const recorder = createModelOperationRecorder({ identity: { operationId: "sharing", kind: "generation", createdAt: 1 } })
    const handles: Array<string> = []
    for (let index = 0; index < 4_096; index++) {
      const frame = { event: "delta", data: `frame-${index}` }
      const source = recorder.registerFrame(frame, { origin: { stage: "upstream", track: "upstream" } })
      handles.push(source)
    }
    recorder.recordEgress({ upstream: { frames: handles as any }, client: { frames: handles as any } })
    const record = recorder.commitTerminal({ outcome: "completed" })
    const naiveTrackNodes = record.egress!.upstream.frames.length + record.egress!.client.frames.length
    const sharingRatio = naiveTrackNodes / record.arena.frames.length

    console.log("HISTORY_V3_PERF unchanged-sharing", JSON.stringify({ arenaNodes: record.arena.frames.length, trackReferences: naiveTrackNodes, sharingRatio }))
    expect(record.arena.frames).toHaveLength(4_096)
    expect(sharingRatio).toBe(2)
    expect(record.egress!.upstream.frames[2_048]).toBe(record.egress!.client.frames[2_048])
  })
})
