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
  findCallOffset,
  isFunctionCall,
  isMethodCall,
  methodCallReceiver,
  parseSource,
} from "./source-ast"

const repoRoot = path.resolve(import.meta.dir, "../..")
const startPath = path.join(repoRoot, "packages/cli/src/start.ts")

type Milestone = "initialize" | "listen" | "backfill"

/**
 * Where each milestone's real CALL occurs, or `null` when it does not exist. `initialize` and
 * `backfill` additionally have to be called on the SAME receiver, so an unrelated `.initialize()`
 * elsewhere in startup cannot stand in for the telemetry runtime's.
 */
function milestoneOffsets(fileName: string, source: string): Record<Milestone, number | null> {
  const sourceFile = parseSource(fileName, source)
  const backfillReceiver =
    findCallOffset(sourceFile, (call) => isMethodCall(call, "runJsonBackfill")) === null ? null : (
      ((): string | null => {
        let receiver: string | null = null
        findCallOffset(sourceFile, (call) => {
          if (!isMethodCall(call, "runJsonBackfill")) return false
          receiver = methodCallReceiver(call)
          return true
        })
        return receiver
      })()
    )

  return {
    initialize: findCallOffset(
      sourceFile,
      (call) => isMethodCall(call, "initialize") && (backfillReceiver === null || methodCallReceiver(call) === backfillReceiver),
    ),
    listen: findCallOffset(sourceFile, (call) => isFunctionCall(call, "startServer")),
    backfill: findCallOffset(sourceFile, (call) => isMethodCall(call, "runJsonBackfill")),
  }
}

/** Human-readable order violations (empty = the wiring holds). */
function orderViolations(fileName: string, source: string): Array<string> {
  const { initialize, listen, backfill } = milestoneOffsets(fileName, source)
  const violations: Array<string> = []
  if (initialize === null) violations.push("telemetry initialize() is missing from the startup path")
  if (listen === null) violations.push("the server-listen call is missing from the startup path")
  if (backfill === null) violations.push("telemetry runJsonBackfill() is missing from the startup path")
  if (initialize === null || listen === null || backfill === null) return violations

  if (!(initialize < listen)) violations.push("telemetry initialize() must run BEFORE the server listens")
  if (!(listen < backfill)) violations.push("telemetry runJsonBackfill() must run AFTER the server listens")
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
    const backfillTooEarly = `
      const telemetryRuntime = installDefaultTelemetryRuntime()
      await telemetryRuntime.initialize()
      telemetryRuntime.runJsonBackfill()
      serverInstance = await startServer({ port })
    `
    expect(violations(backfillTooEarly)).toEqual(["telemetry runJsonBackfill() must run AFTER the server listens"])

    // Initialize deferred past listen — requests could settle against an unbuilt window / unfrozen γ.
    const initializeTooLate = `
      serverInstance = await startServer({ port })
      const telemetryRuntime = installDefaultTelemetryRuntime()
      await telemetryRuntime.initialize()
      telemetryRuntime.runJsonBackfill()
    `
    expect(violations(initializeTooLate)).toEqual(["telemetry initialize() must run BEFORE the server listens"])

    // The wiring deleted outright must not read as "compliant".
    expect(violations(`serverInstance = await startServer({ port })`)).toEqual([
      "telemetry initialize() is missing from the startup path",
      "telemetry runJsonBackfill() is missing from the startup path",
    ])
  })

  test("a commented-out or stringified call reads as ABSENT, not as live wiring", () => {
    // The text version of this guard passed on exactly this: the wiring was deleted, the decoy text
    // remained, and the guard saw a call. An AST sees a comment.
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

    // A block comment wrapping the whole call site is the same thing.
    const blockCommented = `
      const telemetryRuntime = installDefaultTelemetryRuntime()
      /* await telemetryRuntime.initialize() */
      serverInstance = await startServer({ port })
      telemetryRuntime.runJsonBackfill()
    `
    expect(orderViolations("start.ts", blockCommented)).toEqual(["telemetry initialize() is missing from the startup path"])
  })

  test("the real startup path holds the order", async () => {
    const source = await readFile(startPath, "utf8")
    // Non-vacuous: prove the anchors actually resolved against the real file before trusting a pass.
    const offsets = milestoneOffsets(startPath, source)
    expect(offsets.initialize).not.toBeNull()
    expect(offsets.listen).not.toBeNull()
    expect(offsets.backfill).not.toBeNull()

    expect(orderViolations(startPath, source)).toEqual([])
  })
})
