/**
 * Regenerate the circular-dependency ratchet baseline.
 *
 * Run this ONLY after legitimately REDUCING cycles (peeling a domain, breaking
 * an edge) so the ratchet re-freezes at the new, tighter level:
 *
 *   bun run scripts/update-circular-deps-baseline.ts
 *
 * The guard (tests/architecture/circular-deps-ratchet.unit.test.ts) fails on any
 * increase; it passes on a decrease but the baseline then stays loose until you
 * regenerate it here. Commit the updated baseline alongside the improvement.
 */

import { writeFile } from "node:fs/promises"
import path from "node:path"

import { computeCircularSnapshot } from "../tests/architecture/circular-deps-snapshot"

const BASELINE_PATH = path.resolve(import.meta.dir, "../tests/architecture/circular-deps-baseline.json")

const snapshot = await computeCircularSnapshot()
await writeFile(BASELINE_PATH, JSON.stringify(snapshot, null, 2) + "\n")

console.log(`Wrote baseline: ${snapshot.count} cycles, ${snapshot.members.length} files in cycles → ${path.relative(process.cwd(), BASELINE_PATH)}`)
