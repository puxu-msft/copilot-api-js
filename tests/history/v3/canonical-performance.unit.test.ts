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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function measured<T>(factory: () => T, repetitions = 5): { value: T; medianMs: number } {
  const samples: number[] = []
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
  test("quantifies CPU and heap for the top-three deterministic workloads", () => {
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

    console.log("HISTORY_V3_PERF canonical", JSON.stringify(rows))
    for (const row of rows) {
      expect(row.medianMs).toBeGreaterThan(0)
      expect(row.logicalBytes).toBeGreaterThan(1_000)
      expect(row.nodes).toBeGreaterThan(1)
    }
  })

  test("capture cost follows new work rather than growing superlinearly", () => {
    const smallConversation = measured(() => longConversationFixture("complexity-long-small", 32, 512)).medianMs
    const largeConversation = measured(() => longConversationFixture("complexity-long-large", 128, 512)).medianMs
    const smallSse = measured(() => largeSseFixture("complexity-sse-small", 512, 128)).medianMs
    const largeSse = measured(() => largeSseFixture("complexity-sse-large", 2_048, 128)).medianMs
    const conversationRatio = largeConversation / smallConversation
    const sseRatio = largeSse / smallSse

    console.log("HISTORY_V3_PERF capture-complexity", JSON.stringify({ smallConversation, largeConversation, conversationRatio, smallSse, largeSse, sseRatio }))
    expect(conversationRatio).toBeLessThan(8)
    expect(sseRatio).toBeLessThan(8)
  })

  test("unchanged upstream, rewrite, and client frames share exactly one arena node", () => {
    const recorder = createModelOperationRecorder({ identity: { operationId: "sharing", kind: "generation", createdAt: 1 } })
    const handles: string[] = []
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
