/**
 * Circular-dependency snapshot — the shared basis for the SCC ratchet guard.
 *
 * The monorepo split (spec docs/spec/2026-07-22-monorepo-workspace-split.md §6
 * measure 2) freezes the core SCC at its current size: while domains are peeled
 * out incrementally, no NEW import cycle (nor a new file joining a cycle) may be
 * introduced — only removal is allowed. This module computes the current cycle
 * set via `madge` (the spec-prescribed tool, resolving `~/`/`@hsupu/*` aliases
 * through the root tsconfig `paths`), canonicalized into a stable, order-
 * independent shape so the committed baseline
 * (tests/architecture/circular-deps-baseline.json) is a deterministic oracle.
 *
 * Consumed by:
 *   - tests/architecture/circular-deps-ratchet.unit.test.ts (the guard)
 *   - scripts/update-circular-deps-baseline.ts (regenerate after reducing cycles)
 */

import madge from "madge"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")

/** A deterministic, order-independent snapshot of the current import cycles. */
export interface CircularSnapshot {
  /** Number of distinct directed cycles. */
  count: number
  /** Canonicalized cycle strings (each rotated to its lexicographically-smallest start), sorted. */
  cycles: Array<string>
  /** Every file that participates in at least one cycle, sorted+deduped. */
  members: Array<string>
}

/**
 * Canonicalize a directed cycle so the same cycle always maps to the same
 * string regardless of which node madge happened to list first. Rotation (not
 * reordering) preserves direction — `A→B→C→A` and `B→C→A→B` are the same cycle,
 * but `A→C→B→A` is a different one.
 */
function canonicalizeCycle(cycle: Array<string>): string {
  let minIdx = 0
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIdx]) minIdx = i
  }
  return [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)].join(" > ")
}

/**
 * Run madge over `src/` and return the canonical cycle snapshot. Deterministic
 * for a fixed source tree (verified byte-identical across runs); the
 * canonicalization additionally makes it robust to madge listing a cycle from a
 * different starting node in future versions.
 */
export async function computeCircularSnapshot(): Promise<CircularSnapshot> {
  // Every workspace package is a scan root, not just `src/`. Scanning `src/` alone made the snapshot
  // BLIND to a file the moment it was extracted into a package: `state.ts` moving into
  // `packages/foundation` would have dropped out of `members` purely because its path stopped
  // matching, and "state is no longer in any cycle" would have been a path artefact rather than a
  // proof (docs/plan/2026-07-28-state-to-foundation/HANDOVER.md S6). madge dedupes by resolved path,
  // so a file reachable from two roots is still one node.
  const graph = await madge(
    [path.join(REPO_ROOT, "src"), ...["foundation", "token", "telemetry", "cli"].map((name) => path.join(REPO_ROOT, "packages", name, "src"))],
    {
      fileExtensions: ["ts"],
      tsConfig: path.join(REPO_ROOT, "tsconfig.json"),
    },
  )
  const raw = graph.circular()
  const cycles = raw.map(canonicalizeCycle).sort()
  const members = [...new Set(raw.flat())].sort()
  return { count: cycles.length, cycles, members }
}
