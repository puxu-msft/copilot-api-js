/**
 * T2 guard — the telemetry domain has exactly ONE production surface.
 *
 * After the config-injection step the registry's lifecycle / record / read free functions
 * (`initRequestTelemetry`, `recordSettledRequest`, `getDimensionBreakdown`, …) are
 * DOMAIN-INTERNAL: production code reaches them only through the assembled
 * {@link TelemetryRuntime} (`get`/`peekTelemetryRuntime()`), and tests only through the domain's
 * explicit `telemetry-testing` entry (`@hsupu/ghc-proxy-telemetry/testing` after the physical
 * peel). Nothing may keep an unconstrained free-function escape hatch — that is exactly what the
 * peel is removing, and "we converged every consumer" is not a self-validating claim, so it gets a
 * machine oracle.
 *
 * What stays legitimately public on `request-telemetry`: the snapshot/breakdown TYPES and the
 * registry metadata CONSTANTS (`TELEMETRY_MEASURE_NAMES` / `TELEMETRY_HISTOGRAMS` /
 * `DEFAULT_BREAKDOWN_LIMIT`) — they carry no lifecycle and become the package barrel's type +
 * constant surface.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  readdir,
  readFile,
} from "node:fs/promises"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../..")

/** The registry operations that must not be imported outside the telemetry domain. */
const DOMAIN_INTERNAL_OPERATIONS = [
  "initRequestTelemetry",
  "runTelemetryJsonBackfill",
  "recordAcceptedRequest",
  "recordSettledRequest",
  "persistRequestTelemetry",
  "shutdownRequestTelemetry",
  "stopTelemetryBackgroundWork",
  "getRequestTelemetrySnapshot",
  "getDimensionBreakdown",
  "getThinkingBlockTotals",
  "getTelemetryDb",
] as const

/**
 * The telemetry domain's own files (relative to the repo root) — the only ones allowed to import
 * the registry's internals. Everything else is a consumer. Kept as an explicit list rather than a
 * directory prefix because the domain is still spread across `src/lib/` until the physical peel.
 */
const DOMAIN_FILES = new Set(["src/lib/request-telemetry.ts", "src/lib/telemetry-runtime.ts", "src/lib/telemetry-testing.ts"])

/** Source roots that must obey the surface: the core tree + every workspace package. */
async function productionSourceRoots(): Promise<Array<string>> {
  const roots = [path.join(repoRoot, "src")]
  const packagesDir = path.join(repoRoot, "packages")
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    roots.push(path.join(packagesDir, entry.name, "src"))
  }
  return roots
}

async function sourceFiles(root: string): Promise<Array<string>> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(root, entry.name)
      return (
        entry.isDirectory() ? sourceFiles(resolved)
        : entry.isFile() && entry.name.endsWith(".ts") ? [resolved]
        : []
      )
    }),
  )
  return nested.flat()
}

/**
 * The VALUE import blocks that pull from the registry module (`~/lib/request-telemetry` or the
 * in-directory relative `./request-telemetry`). `import type { … }` blocks are deliberately
 * excluded — the types are public.
 */
function registryValueImports(source: string): Array<string> {
  const re = /(?<!\btype\s)import\s*\{([^}]*)\}\s*from\s*["'](?:~\/lib|\.)\/request-telemetry["']/g
  return [...source.matchAll(re)].map((match) => match[1])
}

/** The domain-internal operations a file imports as values from the registry (empty = compliant). */
function forbiddenRegistryOperations(source: string): Array<string> {
  const imported = registryValueImports(source).join(",")
  if (!imported) return []
  return DOMAIN_INTERNAL_OPERATIONS.filter((op) => new RegExp(String.raw`(^|[\s,{])${op}\s*(,|$)`, "m").test(imported))
}

describe("telemetry domain surface (T2 — one production entry point)", () => {
  test("the detector actually bites (positive control on a synthetic consumer)", () => {
    const offending = `import {\n  //\n  recordSettledRequest,\n} from "~/lib/request-telemetry"\n`
    expect(forbiddenRegistryOperations(offending)).toEqual(["recordSettledRequest"])

    // …and on the relative in-directory form a sibling core module could use.
    expect(forbiddenRegistryOperations(`import { getTelemetryDb } from "./request-telemetry"`)).toEqual(["getTelemetryDb"])

    // Negative control: the public type + constant surface must NOT be flagged.
    expect(forbiddenRegistryOperations(`import type { DimensionBreakdownSnapshot } from "~/lib/request-telemetry"`)).toEqual([])
    expect(forbiddenRegistryOperations(`import {\n  //\n  DEFAULT_BREAKDOWN_LIMIT,\n} from "~/lib/request-telemetry"`)).toEqual([])
  })

  test("no production file outside the telemetry domain imports a registry operation", async () => {
    const roots = await productionSourceRoots()
    const files = (await Promise.all(roots.map((root) => sourceFiles(root)))).flat()
    expect(files.length).toBeGreaterThan(100)

    const violations: Array<string> = []
    for (const file of files) {
      const relative = path.relative(repoRoot, file)
      if (DOMAIN_FILES.has(relative)) continue
      const forbidden = forbiddenRegistryOperations(await readFile(file, "utf8"))
      if (forbidden.length > 0) violations.push(`${relative}: ${forbidden.join(", ")}`)
    }
    expect(violations).toEqual([])
  })

  test("the test-only entry is never imported by production code", async () => {
    const roots = await productionSourceRoots()
    const files = (await Promise.all(roots.map((root) => sourceFiles(root)))).flat()

    const violations = []
    for (const file of files) {
      const source = await readFile(file, "utf8")
      if (/["'](?:~\/lib|\.)\/telemetry-testing["']/.test(source)) violations.push(path.relative(repoRoot, file))
    }
    expect(violations).toEqual([])
  })

  test("every domain file listed still exists (no stale allowlist entry)", async () => {
    for (const relative of DOMAIN_FILES) {
      expect(await readFile(path.join(repoRoot, relative), "utf8")).toBeTruthy()
    }
  })
})
