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
 * The detector is exercised on synthetic sources first (both orders), so a green run here means the
 * check reached its target rather than matching nothing.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../..")
const startPath = path.join(repoRoot, "packages/cli/src/start.ts")

/** The three ordered milestones, as the anchors they appear under in the startup path. */
const MILESTONES = {
  initialize: /\.initialize\(\)/,
  listen: /await startServer\(/,
  backfill: /\.runJsonBackfill\(/,
} as const

type Milestone = keyof typeof MILESTONES

/**
 * Where each milestone occurs in a startup source (index of the first match). Returns `null` for a
 * milestone that is absent — an absent milestone is itself a violation (the wiring was deleted).
 */
function milestoneOffsets(source: string): Record<Milestone, number | null> {
  const offsets = {} as Record<Milestone, number | null>
  for (const [name, pattern] of Object.entries(MILESTONES) as Array<[Milestone, RegExp]>) {
    offsets[name] = source.search(pattern) === -1 ? null : source.search(pattern)
  }
  return offsets
}

/** Human-readable order violations (empty = the wiring holds). */
function orderViolations(source: string): Array<string> {
  const { initialize, listen, backfill } = milestoneOffsets(source)
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
    expect(orderViolations(CORRECT_ORDER)).toEqual([])

    // Backfill hoisted before listen — the double-count regression this ordering exists to prevent.
    const backfillTooEarly = `
      const telemetryRuntime = installDefaultTelemetryRuntime()
      await telemetryRuntime.initialize()
      telemetryRuntime.runJsonBackfill()
      serverInstance = await startServer({ port })
    `
    expect(orderViolations(backfillTooEarly)).toEqual(["telemetry runJsonBackfill() must run AFTER the server listens"])

    // Initialize deferred past listen — requests could settle against an unbuilt window / unfrozen γ.
    const initializeTooLate = `
      serverInstance = await startServer({ port })
      const telemetryRuntime = installDefaultTelemetryRuntime()
      await telemetryRuntime.initialize()
      telemetryRuntime.runJsonBackfill()
    `
    expect(orderViolations(initializeTooLate)).toEqual(["telemetry initialize() must run BEFORE the server listens"])

    // The wiring deleted outright must not read as "compliant".
    expect(orderViolations(`serverInstance = await startServer({ port })`)).toEqual([
      "telemetry initialize() is missing from the startup path",
      "telemetry runJsonBackfill() is missing from the startup path",
    ])
  })

  test("the real startup path holds the order", async () => {
    const source = await readFile(startPath, "utf8")
    // Non-vacuous: prove the anchors actually resolved against the real file before trusting a pass.
    const offsets = milestoneOffsets(source)
    expect(offsets.initialize).not.toBeNull()
    expect(offsets.listen).not.toBeNull()
    expect(offsets.backfill).not.toBeNull()

    expect(orderViolations(source)).toEqual([])
  })
})
