/**
 * Guard — the telemetry startup lifecycle keeps its ORDER: `initialize()` before the server
 * listens, `runJsonBackfill()` after.
 *
 * Why the order is load-bearing (peel plan §3.2 / §4):
 *  - `initialize()` rebuilds the in-memory 7d window, freezes the db's sketch γ, and captures the
 *    PRE-STARTUP legacy-JSON snapshot. It must complete before any request can settle, so it runs
 *    before the server accepts connections.
 *  - `runJsonBackfill()` absorbs that frozen snapshot into telemetry.db. It runs AFTER listen so it
 *    never blocks startup, and so the absorbed legacy rows stay structurally disjoint from the
 *    post-startup `tel_raw` writes — moving it earlier reintroduces the double-count this design
 *    closed by construction.
 *
 * This is a SOURCE-ORDER guard rather than a runtime spy, and deliberately so: `runServer` is a
 * ~250-line startup orchestration with no injectable seam, and the alternative — the registry-level
 * `tests/telemetry/backfill-wiring.unit.test.ts` — calls the two functions itself in the right
 * order, so it stays green no matter what `start.ts` does. That is exactly the gap this file fills.
 *
 * Source order is read from the TypeScript AST (`./source-ast`), not from patterns over text: a text
 * version of this guard read a COMMENTED-OUT `// telemetryRuntime.runJsonBackfill()` as live wiring,
 * so deleting the call the guard exists to protect passed it green (found in merged-state review).
 * Only executable `CallExpression` nodes count, so a commented or stringified call reads as ABSENT —
 * which is what it is.
 */

import type ts from "typescript"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

import {
  //
  findCallInScope,
  findFunctionDeclaration,
  isAwaited,
  isFunctionCall,
  isMethodCall,
  methodCallReceiver,
  parseSource,
} from "./source-ast"

const repoRoot = path.resolve(import.meta.dir, "../..")
const startPath = path.join(repoRoot, "packages/cli/src/start.ts")
/** The startup function whose OWN execution flow the milestones must live in. */
const STARTUP_FUNCTION = "runServer"

/** Violations of the startup contract (empty = the wiring holds). */
function orderViolations(fileName: string, source: string, scopeName = STARTUP_FUNCTION): Array<string> {
  const sourceFile = parseSource(fileName, source)
  // Synthetic fragments in the control tests have no enclosing function; fall back to the file scope.
  const scope: ts.Node = findFunctionDeclaration(sourceFile, scopeName) ?? sourceFile

  const backfill = findCallInScope(scope, (call) => isMethodCall(call, "runJsonBackfill"), true)
  const runtimeReceiver = backfill === null ? null : methodCallReceiver(backfill)
  // The runtime's OWN initialize(), not some other object's.
  const initialize = findCallInScope(
    scope,
    (call) => isMethodCall(call, "initialize") && (runtimeReceiver === null || methodCallReceiver(call) === runtimeReceiver),
    true,
  )
  const listen = findCallInScope(scope, (call) => isFunctionCall(call, "startServer"), true)

  const violations: Array<string> = []
  if (initialize === null) violations.push("telemetry initialize() is missing from the startup path")
  if (listen === null) violations.push("the server-listen call is missing from the startup path")
  if (backfill === null) violations.push("telemetry runJsonBackfill() is missing from the startup path")
  if (initialize === null || listen === null || backfill === null) return violations

  // Order alone is not enough: a milestone that must COMPLETE before the next begins has to be
  // awaited, or the source reads correctly while the runtime interleaves.
  if (!isAwaited(initialize)) violations.push("telemetry initialize() must be awaited (or the server can listen against a half-built window)")
  if (!isAwaited(listen)) violations.push("the server-listen call must be awaited (or the backfill can start before the server is up)")

  const offset = (node: ts.CallExpression): number => node.getStart(sourceFile)
  if (!(offset(initialize) < offset(listen))) violations.push("telemetry initialize() must run BEFORE the server listens")
  if (!(offset(listen) < offset(backfill))) violations.push("telemetry runJsonBackfill() must run AFTER the server listens")
  return violations
}

const CORRECT_ORDER = `
  const telemetryRuntime = installDefaultTelemetryRuntime()
  await telemetryRuntime.initialize()
  serverInstance = await startServer({ port })
  telemetryRuntime.runJsonBackfill()
`

describe("telemetry startup order (initialize → listen → runJsonBackfill)", () => {
  test("the detector bites on each way the order can break (positive controls)", () => {
    const violations = (source: string): Array<string> => orderViolations("start.ts", source)
    expect(violations(CORRECT_ORDER)).toEqual([])

    // Backfill hoisted before listen — the double-count regression this ordering exists to prevent.
    expect(
      violations(`
      const telemetryRuntime = installDefaultTelemetryRuntime()
      await telemetryRuntime.initialize()
      telemetryRuntime.runJsonBackfill()
      serverInstance = await startServer({ port })
    `),
    ).toEqual(["telemetry runJsonBackfill() must run AFTER the server listens"])

    // Initialize deferred past listen — requests could settle against an unbuilt window / unfrozen γ.
    expect(
      violations(`
      serverInstance = await startServer({ port })
      const telemetryRuntime = installDefaultTelemetryRuntime()
      await telemetryRuntime.initialize()
      telemetryRuntime.runJsonBackfill()
    `),
    ).toEqual(["telemetry initialize() must run BEFORE the server listens"])

    // The wiring deleted outright must not read as "compliant".
    expect(violations(`serverInstance = await startServer({ port })`)).toEqual([
      "telemetry initialize() is missing from the startup path",
      "telemetry runJsonBackfill() is missing from the startup path",
    ])
  })

  test("ORDER is not enough — a milestone that must complete first has to be awaited", () => {
    // Source order still reads initialize → listen, but without `await` the server can start
    // listening while the 7d window is still being rebuilt and γ is not yet frozen.
    expect(
      orderViolations(
        "start.ts",
        `
      const telemetryRuntime = installDefaultTelemetryRuntime()
      telemetryRuntime.initialize()
      serverInstance = await startServer({ port })
      telemetryRuntime.runJsonBackfill()
    `,
      ),
    ).toEqual(["telemetry initialize() must be awaited (or the server can listen against a half-built window)"])

    expect(
      orderViolations(
        "start.ts",
        `
      const telemetryRuntime = installDefaultTelemetryRuntime()
      await telemetryRuntime.initialize()
      serverInstance = startServer({ port })
      telemetryRuntime.runJsonBackfill()
    `,
      ),
    ).toEqual(["the server-listen call must be awaited (or the backfill can start before the server is up)"])
  })

  test("a call that never executes is not wiring — comments, strings, and dead helpers alike", () => {
    // The text version of this guard passed on a commented-out call: the wiring was deleted, the
    // decoy text remained, and the guard saw a call.
    const commentedOut = `
      const telemetryRuntime = installDefaultTelemetryRuntime()
      await telemetryRuntime.initialize()
      serverInstance = await startServer({ port })
      // telemetryRuntime.runJsonBackfill()
    `
    expect(orderViolations("start.ts", commentedOut)).toEqual(["telemetry runJsonBackfill() is missing from the startup path"])

    const stringified = `
      const telemetryRuntime = installDefaultTelemetryRuntime()
      await telemetryRuntime.initialize()
      serverInstance = await startServer({ port })
      consola.info("next: telemetryRuntime.runJsonBackfill()")
    `
    expect(orderViolations("start.ts", stringified)).toEqual(["telemetry runJsonBackfill() is missing from the startup path"])

    // A real CallExpression parked inside a helper nobody calls: the AST sees it, but it is not
    // wiring. The walk therefore refuses to enter nested callables.
    const deadHelperDecoy = `
      async function runServer(options) {
        const telemetryRuntime = installDefaultTelemetryRuntime()
        await telemetryRuntime.initialize()
        serverInstance = await startServer({ port })
        function unusedBackfillDecoy() {
          telemetryRuntime.runJsonBackfill()
        }
        void unusedBackfillDecoy
      }
    `
    expect(orderViolations("start.ts", deadHelperDecoy)).toEqual(["telemetry runJsonBackfill() is missing from the startup path"])

    // A call gated behind a condition is not unconditional wiring either — `if (false)` today,
    // a feature flag tomorrow. Plain blocks and `try` are still entered: production wraps these
    // very calls in `try`, which does not gate whether they run on the normal path.
    const deadBranch = `
      async function runServer(options) {
        const telemetryRuntime = installDefaultTelemetryRuntime()
        await telemetryRuntime.initialize()
        serverInstance = await startServer({ port })
        if (neverTrue) telemetryRuntime.runJsonBackfill()
      }
    `
    expect(orderViolations("start.ts", deadBranch)).toEqual(["telemetry runJsonBackfill() is missing from the startup path"])

    const wrappedInTry = `
      async function runServer(options) {
        const telemetryRuntime = installDefaultTelemetryRuntime()
        await telemetryRuntime.initialize()
        serverInstance = await startServer({ port })
        try {
          telemetryRuntime.runJsonBackfill()
        } catch (err) {
          consola.warn(err)
        }
      }
    `
    expect(orderViolations("start.ts", wrappedInTry)).toEqual([])

    // …but a `catch` clause runs ONLY when the try throws, so wiring parked there never runs on the
    // normal startup path. Treating catch as unconditional was a real false green: the production
    // backfill could be moved out of the try body into catch and this guard stayed green.
    const catchOnly = `
      async function runServer(options) {
        const telemetryRuntime = installDefaultTelemetryRuntime()
        await telemetryRuntime.initialize()
        serverInstance = await startServer({ port })
        try {
          // normal path no longer runs it
        } catch (err) {
          telemetryRuntime.runJsonBackfill()
        }
      }
    `
    expect(orderViolations("start.ts", catchOnly)).toEqual(["telemetry runJsonBackfill() is missing from the startup path"])

    // `finally` runs on BOTH paths, so it is legitimate wiring.
    const inFinally = `
      async function runServer(options) {
        const telemetryRuntime = installDefaultTelemetryRuntime()
        await telemetryRuntime.initialize()
        serverInstance = await startServer({ port })
        try {
          somethingElse()
        } finally {
          telemetryRuntime.runJsonBackfill()
        }
      }
    `
    expect(orderViolations("start.ts", inFinally)).toEqual([])
  })

  test("a call that is present but unreachable is not wiring either", () => {
    // A lifecycle call that MUST run may never be optional-chained: the whole call is skipped when
    // the receiver is nullish, so this is not wiring whatever the receiver's declared type says.
    const optionalChained = `
      async function runServer(options) {
        const telemetryRuntime = installDefaultTelemetryRuntime()
        await telemetryRuntime.initialize()
        serverInstance = await startServer({ port })
        telemetryRuntime?.runJsonBackfill()
      }
    `
    expect(orderViolations("start.ts", optionalChained)).toEqual(["telemetry runJsonBackfill() is missing from the startup path"])

    // A labeled block can be jumped out of before reaching the call.
    const labeled = `
      async function runServer(options) {
        const telemetryRuntime = installDefaultTelemetryRuntime()
        await telemetryRuntime.initialize()
        serverInstance = await startServer({ port })
        backfill: {
          break backfill
          telemetryRuntime.runJsonBackfill()
        }
      }
    `
    expect(orderViolations("start.ts", labeled)).toEqual(["telemetry runJsonBackfill() is missing from the startup path"])

    // Everything after an unconditional return/throw in the same statement list is dead.
    const afterThrow = `
      async function runServer(options) {
        const telemetryRuntime = installDefaultTelemetryRuntime()
        await telemetryRuntime.initialize()
        serverInstance = await startServer({ port })
        throw new Error("boom")
        telemetryRuntime.runJsonBackfill()
      }
    `
    expect(orderViolations("start.ts", afterThrow)).toEqual(["telemetry runJsonBackfill() is missing from the startup path"])

    const afterReturn = `
      async function runServer(options) {
        const telemetryRuntime = installDefaultTelemetryRuntime()
        await telemetryRuntime.initialize()
        serverInstance = await startServer({ port })
        return
        telemetryRuntime.runJsonBackfill()
      }
    `
    expect(orderViolations("start.ts", afterReturn)).toEqual(["telemetry runJsonBackfill() is missing from the startup path"])
  })

  test("the real startup path marks the listening phase (the runtime's ordering hook)", async () => {
    // The ordering itself is now enforced INSIDE the runtime (see its doc + the runtime oracle in
    // tests/telemetry/telemetry-runtime.unit.test.ts). That enforcement only engages if startup
    // actually tells the runtime it is listening, so this checks the hook is wired — and that it
    // sits between listen and backfill, which is the one thing the runtime cannot check for itself.
    const source = await readFile(startPath, "utf8")
    const sourceFile = parseSource(startPath, source)
    const scope = findFunctionDeclaration(sourceFile, STARTUP_FUNCTION)
    expect(scope).not.toBeNull()
    const mark = findCallInScope(scope!, (call) => isMethodCall(call, "markServerListening"), true)
    const listen = findCallInScope(scope!, (call) => isFunctionCall(call, "startServer"), true)
    const backfill = findCallInScope(scope!, (call) => isMethodCall(call, "runJsonBackfill"), true)
    expect(mark).not.toBeNull()
    expect(listen!.getStart(sourceFile)).toBeLessThan(mark!.getStart(sourceFile))
    expect(mark!.getStart(sourceFile)).toBeLessThan(backfill!.getStart(sourceFile))
  })

  test("the real startup path holds the whole contract", async () => {
    const source = await readFile(startPath, "utf8")
    // Non-vacuous: the scope and all three milestones must actually resolve in the real file before
    // an empty violation list means anything.
    const sourceFile = parseSource(startPath, source)
    const scope = findFunctionDeclaration(sourceFile, STARTUP_FUNCTION)
    expect(scope).not.toBeNull()
    expect(findCallInScope(scope!, (call) => isMethodCall(call, "initialize"))).not.toBeNull()
    expect(findCallInScope(scope!, (call) => isFunctionCall(call, "startServer"))).not.toBeNull()
    expect(findCallInScope(scope!, (call) => isMethodCall(call, "runJsonBackfill"))).not.toBeNull()

    expect(orderViolations(startPath, source)).toEqual([])
  })
})
