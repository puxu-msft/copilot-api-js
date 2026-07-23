/**
 * SCC ratchet guard — freeze the core import-cycle set at its current size.
 *
 * Monorepo split spec §6 measure 2: while domains are peeled out of the 19-module
 * core SCC incrementally, the cycle set must only SHRINK. This guard fails if a
 * new import cycle appears, or a new file joins any cycle — "新增环或环成员数增加即
 * fail、只减不增才过". It does NOT fail when cycles are removed (that is the goal);
 * after reducing cycles, regenerate the baseline:
 *
 *   bun run scripts/update-circular-deps-baseline.ts
 *
 * The current cycle set is computed by madge (resolving `~/`/`@hsupu/*` aliases
 * via the root tsconfig), canonicalized for determinism — see
 * ./circular-deps-snapshot.ts. Mirrors the other tests/architecture/* guards.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import {
  //
  type CircularSnapshot,
  computeCircularSnapshot,
} from "./circular-deps-snapshot"

const BASELINE_PATH = path.resolve(import.meta.dir, "circular-deps-baseline.json")
const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as CircularSnapshot

describe("SCC ratchet: import cycles only shrink", () => {
  test("baseline is a real, non-vacuous snapshot (guard is not comparing against nothing)", () => {
    // Self-check: an empty baseline would make the ratchet trivially pass while
    // the SCC grows underneath it (pass-null blindness).
    expect(baseline.count).toBeGreaterThan(10)
    expect(baseline.cycles.length).toBe(baseline.count)
    expect(baseline.members.length).toBeGreaterThan(10)
  })

  test("no NEW import cycle and no NEW file joins a cycle (only removal is allowed)", async () => {
    const current = await computeCircularSnapshot()

    const baselineCycles = new Set(baseline.cycles)
    const baselineMembers = new Set(baseline.members)

    const newCycles = current.cycles.filter((c) => !baselineCycles.has(c))
    const newMembers = current.members.filter((m) => !baselineMembers.has(m))

    // Rich failure output: name exactly what regressed so the author can fix
    // the offending edge (or, if the new cycle is unavoidable + intentional,
    // regenerate the baseline with the documented script).
    expect(
      newMembers,
      `New file(s) joined an import cycle — the core SCC grew. Break the offending edge, or if intentional run \`bun run scripts/update-circular-deps-baseline.ts\`. New members:\n${newMembers.join("\n")}`,
    ).toEqual([])
    expect(
      newCycles,
      `New import cycle(s) introduced — the core SCC gained a cycle. Break the offending edge, or if intentional run \`bun run scripts/update-circular-deps-baseline.ts\`. New cycles:\n${newCycles.join("\n\n")}`,
    ).toEqual([])

    // Count can only stay the same or drop (subset of baseline cycles).
    expect(current.count).toBeLessThanOrEqual(baseline.count)
  }, 30_000)
})
