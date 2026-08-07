import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

import {
  //
  createModelOperationRecorder,
  setCaptureWorkObserverForTests,
} from "~/lib/context/model-operation-record"

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

function captureWork(factory: () => ReturnType<typeof longConversationFixture>): {
  readonly record: ReturnType<typeof longConversationFixture>
  readonly visits: number
} {
  let visits = 0
  setCaptureWorkObserverForTests(() => visits++)
  try {
    return { record: factory(), visits }
  } finally {
    setCaptureWorkObserverForTests(undefined)
  }
}

function population(record: ReturnType<typeof longConversationFixture>): Record<string, number> {
  return {
    payloads: record.arena.payloads.length,
    frames: record.arena.frames.length,
    dispatches: record.dispatches.length,
    candidates: record.candidates.length,
    transforms: record.transforms.length,
  }
}

function recursiveFunctionNames(source: string): Array<string> {
  const sourceFile = ts.createSourceFile("model-operation-record.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions = new Map<string, ts.FunctionLikeDeclaration>()

  const collectFunctions = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) functions.set(node.name.text, node)
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      functions.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, collectFunctions)
  }
  collectFunctions(sourceFile)

  const calls = new Map<string, Set<string>>()
  for (const [name, declaration] of functions) {
    const callees = new Set<string>()
    const collectCalls = (node: ts.Node): void => {
      if (node !== declaration && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && functions.has(node.expression.text)) callees.add(node.expression.text)
      ts.forEachChild(node, collectCalls)
    }
    if (declaration.body !== undefined) ts.forEachChild(declaration.body, collectCalls)
    calls.set(name, callees)
  }

  const recursive = new Set<string>()
  for (const name of functions.keys()) {
    const reached = new Set<string>()
    const visit = (current: string): void => {
      if (reached.has(current)) return
      reached.add(current)
      for (const callee of calls.get(current) ?? []) visit(callee)
    }
    for (const callee of calls.get(name) ?? []) visit(callee)
    if (reached.has(name)) recursive.add(name)
  }
  return [...recursive].sort()
}

const RECORDER_SOURCE = readFileSync(join(import.meta.dir, "../../../src/lib/context/model-operation-record.ts"), "utf8")

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
      expect(row.logicalBytes).toBeGreaterThan(1_000)
      expect(row.nodes).toBeGreaterThan(1)
    }
  })

  test("recursive captured-value freeze and sealed arena copies scale with new messages and frames", () => {
    expect(RECORDER_SOURCE).toContain("function copyCapturedArena")
    expect(RECORDER_SOURCE).toContain("arena: Object.freeze({ payloads: copyCapturedArena(payloads), frames: copyCapturedArena(frames) })")

    const smallConversation = captureWork(() => longConversationFixture("complexity-long-small", 32, 512))
    const largeConversation = captureWork(() => longConversationFixture("complexity-long-large", 128, 512))
    const smallSse = captureWork(() => largeSseFixture("complexity-sse-small", 512, 128))
    const largeSse = captureWork(() => largeSseFixture("complexity-sse-large", 2_048, 128))

    expect(population(smallConversation.record)).toEqual({ payloads: 1, frames: 32, dispatches: 1, candidates: 1, transforms: 0 })
    expect(population(largeConversation.record)).toEqual({ payloads: 1, frames: 128, dispatches: 1, candidates: 1, transforms: 0 })
    expect(population(smallSse.record)).toEqual({ payloads: 1, frames: 512, dispatches: 1, candidates: 1, transforms: 0 })
    expect(population(largeSse.record)).toEqual({ payloads: 1, frames: 2_048, dispatches: 1, candidates: 1, transforms: 0 })

    const conversationRatio = largeConversation.visits / smallConversation.visits
    const sseRatio = largeSse.visits / smallSse.visits
    console.log(
      "HISTORY_V3_PERF capture-work",
      JSON.stringify({
        smallConversationWork: smallConversation.visits,
        largeConversationWork: largeConversation.visits,
        conversationRatio,
        smallSseWork: smallSse.visits,
        largeSseWork: largeSse.visits,
        sseRatio,
      }),
    )
    expect(conversationRatio).toBeLessThan(8)
    expect(sseRatio).toBeLessThan(8)
  })

  test("captured-value traversal has one recursive implementation", () => {
    expect(recursiveFunctionNames(RECORDER_SOURCE)).toEqual(["freezeCapturedValue"])
  })

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
