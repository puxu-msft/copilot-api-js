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

type FunctionInfo = {
  readonly declaration: ts.FunctionLikeDeclaration
  readonly productionRoot: boolean
}

function isRecorderMethod(node: ts.MethodDeclaration): boolean {
  const object = node.parent
  const declaration = object.parent
  return (
    ts.isObjectLiteralExpression(object) && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.name.text === "recorder"
  )
}

function canonicalRecursiveSccs(source: string): Array<{ readonly members: ReadonlySet<string>; readonly observesWork: boolean }> {
  const sourceFile = ts.createSourceFile("model-operation-record.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions = new Map<string, FunctionInfo>()
  const aliases = new Map<string, string>()

  const register = (name: string, declaration: ts.FunctionLikeDeclaration, productionRoot: boolean, extraAlias?: string): void => {
    functions.set(name, { declaration, productionRoot })
    aliases.set(name, name)
    if (extraAlias !== undefined) aliases.set(extraAlias, name)
  }
  const collectFunctions = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) register(node.name.text, node, false)
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) register(node.name.text, node, isRecorderMethod(node))
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      register(
        node.name.text,
        node.initializer,
        false,
        ts.isFunctionExpression(node.initializer) && node.initializer.name !== undefined ? node.initializer.name.text : undefined,
      )
    }
    ts.forEachChild(node, collectFunctions)
  }
  collectFunctions(sourceFile)

  const calls = new Map<string, Set<string>>()
  const observesWork = new Set<string>()
  for (const [name, { declaration }] of functions) {
    const callees = new Set<string>()
    const collectCalls = (node: ts.Node): void => {
      const isFunctionLike = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)
      const isNestedFunction = node !== declaration && isFunctionLike
      if (isNestedFunction) return
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = aliases.get(node.expression.text)
        if (callee !== undefined) callees.add(callee)
        if (node.expression.text === "captureWorkObserver") observesWork.add(name)
      }
      ts.forEachChild(node, collectCalls)
    }
    if (declaration.body !== undefined) ts.forEachChild(declaration.body, collectCalls)
    calls.set(name, callees)
  }

  const reachable = new Set<string>()
  const visit = (name: string): void => {
    if (reachable.has(name)) return
    reachable.add(name)
    for (const callee of calls.get(name) ?? []) visit(callee)
  }
  for (const [name, info] of functions) if (info.productionRoot) visit(name)

  const reachesObserver = new Set<string>()
  const markObserverAncestors = (name: string): void => {
    if (reachesObserver.has(name)) return
    reachesObserver.add(name)
    for (const [caller, callees] of calls) if (callees.has(name)) markObserverAncestors(caller)
  }
  for (const observer of observesWork) markObserverAncestors(observer)

  const domain = new Set([...reachable].filter((name) => reachesObserver.has(name)))
  const reachFrom = (start: string): Set<string> => {
    const reached = new Set<string>()
    const visitReachable = (name: string): void => {
      if (!domain.has(name) || reached.has(name)) return
      reached.add(name)
      for (const callee of calls.get(name) ?? []) visitReachable(callee)
    }
    visitReachable(start)
    return reached
  }

  const seenComponents = new Set<string>()
  const components: Array<{ readonly members: ReadonlySet<string>; readonly observesWork: boolean }> = []
  for (const name of reachable) {
    const members = new Set([...reachFrom(name)].filter((candidate) => reachFrom(candidate).has(name)))
    const returnsToStart = [...(calls.get(name) ?? [])].some((callee) => reachFrom(callee).has(name))
    if (!returnsToStart) continue
    const key = [...members].sort().join("|")
    if (seenComponents.has(key)) continue
    seenComponents.add(key)
    components.push({ members, observesWork: [...members].some((member) => observesWork.has(member)) })
  }
  return components
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

  test("captured-value traversal has one observer-bearing recursive SCC reachable from canonical registration roots", () => {
    const recursiveSccs = canonicalRecursiveSccs(RECORDER_SOURCE)
    expect(recursiveSccs).toHaveLength(1)
    expect(recursiveSccs[0].observesWork).toBe(true)
  })

  test("scoped recursion guard is independent of canonical names and ignores unrelated recursion", () => {
    const renamed = ["registerPayload", "derivePayload", "registerFrame", "deriveFrame", "freezeCapturedValue"].reduce(
      (source, name, index) => source.replaceAll(name, `canonicalRenamed${index}`),
      RECORDER_SOURCE,
    )
    const unrelated = `${RECORDER_SOURCE}\nfunction unrelatedRecursion(value: number): number { return value === 0 ? 0 : unrelatedRecursion(value - 1) }\n`

    for (const source of [renamed, unrelated]) {
      const recursiveSccs = canonicalRecursiveSccs(source)
      expect(recursiveSccs).toHaveLength(1)
      expect(recursiveSccs[0].observesWork).toBe(true)
    }
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
