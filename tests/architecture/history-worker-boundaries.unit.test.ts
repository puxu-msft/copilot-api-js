import { Glob } from "bun"
import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

import {
  //
  allModuleSpecifiers,
  createSpecifierResolver,
  parseSource,
  typeOnlyModuleSpecifiers,
} from "./source-ast"

const repoRoot = path.resolve(import.meta.dir, "../..")
const resolveSpecifier = createSpecifierResolver(repoRoot)

interface AdmissionSite {
  readonly file: string
  readonly functionName: string
}

const PRODUCTION_OPERATION_SITES: ReadonlyArray<AdmissionSite> = [
  { file: "src/routes/chat-completions/handler-v4.ts", functionName: "handleChatCompletionV4" },
  { file: "src/routes/responses/handler-v4.ts", functionName: "handleResponsesV4" },
  { file: "src/routes/messages/handler-v4.ts", functionName: "handleMessagesV4" },
  { file: "src/routes/embeddings/route.ts", functionName: "handleEmbeddings" },
  { file: "src/routes/messages/count-tokens.ts", functionName: "handleCountTokens" },
  { file: "src/routes/gemini/handler-v4.ts", functionName: "runGeminiRequest" },
  { file: "src/routes/gemini/handler.ts", functionName: "handleCountTokens" },
  { file: "src/routes/responses/ws.ts", functionName: "handleResponseCreate" },
]

function namedFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionLikeDeclaration {
  let match: ts.FunctionLikeDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node))
      && node.name
      && ts.isIdentifier(node.name)
      && node.name.text === name
    ) {
      match = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!match) throw new Error(`Missing production operation function ${name} in ${sourceFile.fileName}`)
  return match
}

function historyAdmissionCalls(node: ts.Node): number {
  let calls = 0
  const visit = (candidate: ts.Node): void => {
    if (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression) && candidate.expression.text === "withHistoryAdmission") {
      calls++
    }
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return calls
}

describe("History production admission boundaries", () => {
  test("AST criterion sees a live wrapper call but ignores comments and strings", () => {
    const live = parseSource("live.ts", "async function operation() { return withHistoryAdmission(c, 'generation', run) }")
    const inert = parseSource("inert.ts", "function operation() { const note = 'withHistoryAdmission(c)'; /* withHistoryAdmission(c) */ return note }")

    expect(historyAdmissionCalls(namedFunction(live, "operation"))).toBe(1)
    expect(historyAdmissionCalls(namedFunction(inert, "operation"))).toBe(0)
  })

  test("every production operation owner acquires exactly one History reservation", async () => {
    for (const site of PRODUCTION_OPERATION_SITES) {
      const absolute = path.join(repoRoot, site.file)
      const sourceFile = parseSource(absolute, await readFile(absolute, "utf8"))
      expect(historyAdmissionCalls(namedFunction(sourceFile, site.functionName)), `${site.file}:${site.functionName}`).toBe(1)
    }
  })

  test("Azure deployment routes reuse admitted handlers instead of acquiring a second reservation", async () => {
    const file = path.join(repoRoot, "src/routes/azure-openai/route.ts")
    const sourceFile = parseSource(file, await readFile(file, "utf8"))
    expect(historyAdmissionCalls(sourceFile)).toBe(0)
  })
})

/**
 * The point of moving History persistence onto a Worker is that the SQLite driver, the compression
 * codec and the V3 store stop being reachable from the main thread's event loop. That property is
 * created by which module imports which — nothing about it shows up in a functional test, and a
 * single added import silently undoes it while every other test stays green.
 *
 * Deliberately scoped to the main-thread Worker-runtime subgraph. Asserting that the whole CLI
 * entry is free of `v3/store` would be false today and is meant to be: the legacy main-thread
 * writer is still the production authority until Batch 2b, and the read path until Batch 6c.
 * Widening this to the whole process belongs to the batch that removes those, not to this one.
 */
const MAIN_THREAD_WORKER_ENTRYPOINTS = [
  //
  "src/lib/history/worker/runtime.ts",
  "src/lib/history/worker/registry.ts",
  "src/lib/history/worker/admission.ts",
  "src/lib/history/worker/status.ts",
]

/** Modules that may only ever be loaded on the Worker thread. */
const WORKER_ONLY_MODULES = [
  //
  "src/lib/history/worker/backend.ts",
  "src/lib/history/v3/store.ts",
  "src/lib/history/sqlite/connection.ts",
  "packages/foundation/src/sqlite/driver.ts",
  "packages/foundation/src/sqlite/compression.ts",
]

/**
 * `backend.ts` owns the Worker's SQLite handle. Only the Worker entry may pull it into a real
 * module graph; the test fixtures reproduce the Worker on purpose (spec §12.1 requires the
 * in-process contract backend to be the same code, not a friendlier stand-in).
 */
const ALLOWED_BACKEND_IMPORTERS = [
  //
  "src/lib/history/worker/history-worker.ts",
  "tests/history/worker/fixtures/in-process-runtime.ts",
  "tests/history/worker/fixtures/crash-window-worker.ts",
  "tests/history/worker/fixtures/permanent-failure-worker.ts",
  "tests/history/worker/fixtures/retry-observer-worker.ts",
  "tests/history/worker/fixtures/retryable-startup-worker.ts",
]

/**
 * Specifiers this file imports for their VALUES.
 *
 * Counting matters: a module is routinely imported twice from the same path, once `import type`
 * and once for real (`v3/store.ts` does exactly this with `../sqlite/connection`). Subtracting by
 * NAME would erase the value import along with the type import and silently shrink the closure —
 * the positive control below exists because that is precisely the bug this helper shipped with.
 *
 * The remaining inaccuracy is fail-closed: an `import("x").T` type reference counts as a value,
 * so at worst this guard over-reports a breach and someone has to look.
 */
function valueModuleSpecifiers(sourceFile: ts.SourceFile): Array<string> {
  const remainingTypeOnly = new Map<string, number>()
  for (const specifier of typeOnlyModuleSpecifiers(sourceFile)) {
    remainingTypeOnly.set(specifier, (remainingTypeOnly.get(specifier) ?? 0) + 1)
  }
  const values: Array<string> = []
  for (const specifier of allModuleSpecifiers(sourceFile)) {
    const remaining = remainingTypeOnly.get(specifier) ?? 0
    if (remaining > 0) {
      remainingTypeOnly.set(specifier, remaining - 1)
      continue
    }
    values.push(specifier)
  }
  return values
}

/**
 * Walk the VALUE import closure of `entry`. Type-only imports are excluded on purpose: they are
 * erased before runtime and therefore cannot drag a driver onto the main thread — `runtime.ts`
 * legitimately imports the protocol's types from a module the Worker also uses.
 */
function valueImportClosure(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [path.join(repoRoot, entry)]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    const sourceFile = parseSource(current, readFileSync(current, "utf8"))
    for (const specifier of valueModuleSpecifiers(sourceFile)) {
      const resolved = resolveSpecifier(current, specifier)
      if (resolved && !resolved.includes("node_modules")) queue.push(resolved)
    }
  }
  return seen
}

describe("History Worker thread ownership", () => {
  test("the main-thread Worker runtime never value-imports a Worker-only module", () => {
    const forbidden = WORKER_ONLY_MODULES.map((file) => path.join(repoRoot, file))
    for (const entry of MAIN_THREAD_WORKER_ENTRYPOINTS) {
      const closure = valueImportClosure(entry)
      const breaches = forbidden.filter((file) => closure.has(file)).map((file) => path.relative(repoRoot, file))
      expect(breaches, `${entry} must not reach a Worker-only module`).toEqual([])
    }
  })

  test("the closure walker actually sees a value import it should reject", () => {
    // Positive control: the Worker entry DOES import the backend, so a walker that reported no
    // breaches everywhere — the way a broken resolver would — is distinguishable from a real pass.
    const closure = valueImportClosure("src/lib/history/worker/history-worker.ts")
    expect(closure.has(path.join(repoRoot, "src/lib/history/worker/backend.ts"))).toBe(true)
    expect(closure.has(path.join(repoRoot, "src/lib/history/v3/store.ts"))).toBe(true)
    expect(closure.has(path.join(repoRoot, "src/lib/history/sqlite/connection.ts"))).toBe(true)
  })

  test("only the Worker entry and the Worker-reproducing fixtures import the backend", async () => {
    const allowed = new Set(ALLOWED_BACKEND_IMPORTERS)
    const backend = path.join(repoRoot, "src/lib/history/worker/backend.ts")
    const importers: Array<string> = []
    for (const pattern of ["src/**/*.ts", "packages/*/src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"]) {
      for (const relative of new Glob(pattern).scanSync({ cwd: repoRoot, onlyFiles: true })) {
        const absolute = path.join(repoRoot, relative)
        if (absolute === backend) continue
        const source = readFileSync(absolute, "utf8")
        if (!source.includes("worker/backend") && !source.includes("./backend")) continue
        const sourceFile = parseSource(absolute, source)
        const reaches = valueModuleSpecifiers(sourceFile).some((specifier) => resolveSpecifier(absolute, specifier) === backend)
        if (reaches) importers.push(relative)
      }
    }
    expect(importers.sort()).toEqual([...allowed].sort())
  })
})

/**
 * Count `this.<method>(...)` calls anywhere beneath `node`.
 *
 * Deliberately syntactic and deliberately narrow: it answers "does this function body reach
 * for that transition at all", which is a property of the code's shape rather than of any
 * particular run.
 */
function methodCalls(node: ts.Node, method: string): number {
  let calls = 0
  const visit = (candidate: ts.Node): void => {
    if (
      ts.isCallExpression(candidate)
      && ts.isPropertyAccessExpression(candidate.expression)
      && candidate.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      && candidate.expression.name.text === method
    ) {
      calls++
    }
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return calls
}

/**
 * A crash count may never synthesise the irreversible terminal state.
 *
 * Spec §7.1 routes ordinary crashes and retryable startup errors through the automatic
 * restart; §7.2 reserves `terminal-failed` for conditions already known to be permanent, and
 * "crashed N times" is not one — a fault that would have cleared on attempt N+1 must still be
 * able to recover. A behavioural test can only ever show that some specific N does not
 * terminate, so it cannot express this: an implementation that gives up at N+1 stays green.
 * The invariant is therefore stated where it is actually decidable — the crash handler does
 * not contain the transition at all.
 */
describe("History Worker crash handling never synthesises a terminal state", () => {
  test("the criterion sees a real transition call and ignores a lookalike", () => {
    const live = parseSource("live.ts", "class R { private handleTransportCrash() { this.failTerminal(new Error('x')) } }")
    const inert = parseSource("inert.ts", "class R { private handleTransportCrash() { const note = 'this.failTerminal()'; other.failTerminal() } }")

    expect(methodCalls(namedFunction(live, "handleTransportCrash"), "failTerminal")).toBe(1)
    expect(methodCalls(namedFunction(inert, "handleTransportCrash"), "failTerminal")).toBe(0)
  })

  test("handleTransportCrash contains no path to failTerminal", () => {
    const file = path.join(repoRoot, "src/lib/history/worker/runtime.ts")
    const sourceFile = parseSource(file, readFileSync(file, "utf8"))

    expect(methodCalls(namedFunction(sourceFile, "handleTransportCrash"), "failTerminal")).toBe(0)
  })

  test("the restart policy exposes no attempt ceiling to decide on", () => {
    const file = path.join(repoRoot, "src/lib/history/worker/restart-policy.ts")
    const sourceFile = parseSource(file, readFileSync(file, "utf8"))

    // AST, not substring: "exhausted" is an ordinary English word and appears in this file's
    // prose ("exhausted disk"), so a text match reports a breach that does not exist. The
    // property is about declared members — a ceiling cannot be consulted if none is declared.
    // (Removed 2026-08-09 by user ruling; the startup deadline belongs to whoever owns
    // process startup — see docs/todo/deferred-backlog.md.)
    const declaredMembers = new Set<string>()
    const visit = (node: ts.Node): void => {
      if ((ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
        for (const member of node.members) {
          if (member.name && ts.isIdentifier(member.name)) declaredMembers.add(member.name.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)

    expect([...declaredMembers].filter((name) => name === "maxConsecutiveFailures" || name === "exhausted")).toEqual([])
    // Positive control: the walker does see the members that ARE declared.
    expect(declaredMembers.has("consecutiveFailures")).toBe(true)
    expect(declaredMembers.has("recordFailure")).toBe(true)
  })
})

/**
 * The in-process V3 writer entry points the Batch 2b cutover took off the production path.
 *
 * They survive as primitives for tests, scripts and the Worker's own backend; what must not
 * come back is the main thread calling them, because that is the second writer this whole
 * migration exists to remove. A source guard rather than a behavioural one on purpose: the
 * regression it catches is someone reaching for the old, still-exported function while
 * everything else keeps working, which no runtime assertion notices.
 */
const RETIRED_MAIN_THREAD_WRITER_CALLS = ["enqueueModelOperationWithOutcome", "drainV3Writer"] as const

function identifierCalls(node: ts.Node, name: string): number {
  let calls = 0
  const visit = (candidate: ts.Node): void => {
    if (ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression) && candidate.expression.text === name) calls++
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return calls
}

describe("History semantic writes have left the main thread", () => {
  const stateFile = path.join(repoRoot, "src/lib/history/state.ts")
  const stateSource = ts.createSourceFile(stateFile, readFileSync(stateFile, "utf8"), ts.ScriptTarget.Latest, true)

  test("state.ts drives the Worker runtime and never the in-process V3 writer", () => {
    for (const name of RETIRED_MAIN_THREAD_WRITER_CALLS) {
      expect(identifierCalls(stateSource, name), `src/lib/history/state.ts still calls ${name}() — the semantic writer lives on the Worker`).toBe(0)
    }
    // Positive control: a zero above has to mean "absent", not "the walker sees nothing".
    expect(identifierCalls(stateSource, "drainModelOperationTerminalSubscribers")).toBeGreaterThan(0)
  })

  test("no production module installs a legacy in-process terminal sink", async () => {
    const offenders: Array<string> = []
    for await (const relative of new Glob("**/*.ts").scan({ cwd: path.join(repoRoot, "src") })) {
      const source = await readFile(path.join(repoRoot, "src", relative), "utf8")
      if (/legacy-terminal-sink|LegacyHistoryTerminalSink/.test(source)) offenders.push(`src/${relative}`)
    }
    expect(offenders, "the legacy terminal-sink adapter was the Batch 2a bridge; production must reach the Worker runtime directly").toEqual([])
    // Positive control for the scan itself: it really is reading source, and would find a name that IS there.
    const registry = await readFile(path.join(repoRoot, "src/lib/history/worker/registry.ts"), "utf8")
    expect(registry).toContain("HistoryPersistenceRuntimeImpl")
  })
})
