/**
 * Guard — the telemetry package has exactly ONE production surface.
 *
 * The registry's lifecycle / record / read free functions (`initRequestTelemetry`,
 * `recordSettledRequest`, `getDimensionBreakdown`, …) are PACKAGE-INTERNAL: production code reaches
 * them only through the assembled `TelemetryRuntime` exported by the barrel, and tests only through
 * the package's explicit `./testing` entry. Nothing may keep an unconstrained free-function escape
 * hatch — that is exactly what the peel removed, and "we converged every consumer" is not a
 * self-validating claim, so it gets a machine oracle.
 *
 * Two independent ways the surface could leak, both covered here:
 *  1. the BARREL could re-export an operation (making it public by accident), and
 *  2. a consumer could DEEP-import `@hsupu/ghc-proxy-telemetry/request-telemetry` (or `/testing`),
 *     bypassing the barrel — the package's `exports` map allows subpaths, so only a guard stops it.
 *
 * What stays legitimately public: the snapshot/breakdown TYPES, the registry metadata CONSTANTS
 * (`TELEMETRY_MEASURE_NAMES` / `TELEMETRY_HISTOGRAMS` / `DEFAULT_BREAKDOWN_LIMIT`), the dimension
 * name registry, and the SQLite tier read primitives — none carry lifecycle.
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
const telemetryPackageSrc = path.join(repoRoot, "packages/telemetry/src")

/** The registry operations that must not escape the package. */
const PACKAGE_INTERNAL_OPERATIONS = [
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

/** Module specifiers that reach past the barrel into the package's internals. */
const DEEP_INTERNAL_SPECIFIERS = [
  "@hsupu/ghc-proxy-telemetry/request-telemetry",
  "@hsupu/ghc-proxy-telemetry/runtime",
  "@hsupu/ghc-proxy-telemetry/dependencies",
  "@hsupu/ghc-proxy-telemetry/dimension-names",
  "@hsupu/ghc-proxy-telemetry/testing",
] as const

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

/** Every specifier a file imports from, in any import form (static / side-effect / dynamic / require). */
function importedSpecifiers(source: string): Array<string> {
  const re = /(?:\bfrom|\bimport|\brequire)\s*(?:\(\s*)?["']([^"']+)["']/g
  return [...source.matchAll(re)].map((match) => match[1])
}

/** The package-internal specifiers a file reaches for (empty = compliant). */
function deepInternalImports(source: string): Array<string> {
  const specifiers = new Set(importedSpecifiers(source))
  return DEEP_INTERNAL_SPECIFIERS.filter((deep) => specifiers.has(deep))
}

describe("telemetry package surface (one production entry point)", () => {
  test("the detector actually bites (positive control on a synthetic consumer)", () => {
    expect(deepInternalImports(`import { recordSettledRequest } from "@hsupu/ghc-proxy-telemetry/request-telemetry"`)).toEqual([
      "@hsupu/ghc-proxy-telemetry/request-telemetry",
    ])
    // …and on the non-`from` import shapes a consumer could otherwise slip through.
    expect(deepInternalImports(`await import("@hsupu/ghc-proxy-telemetry/testing")`)).toEqual(["@hsupu/ghc-proxy-telemetry/testing"])
    expect(deepInternalImports(`const x = require("@hsupu/ghc-proxy-telemetry/runtime")`)).toEqual(["@hsupu/ghc-proxy-telemetry/runtime"])

    // Negative control: the barrel and the storage subpath (a legitimate internals-test target) are fine.
    expect(deepInternalImports(`import { getTelemetryRuntime } from "@hsupu/ghc-proxy-telemetry"`)).toEqual([])
    expect(deepInternalImports(`import { openTelemetryDb } from "@hsupu/ghc-proxy-telemetry/telemetry/db"`)).toEqual([])
  })

  test("the barrel exports no registry OPERATION (only types, constants, the runtime and the tier reads)", async () => {
    const barrel = await readFile(path.join(telemetryPackageSrc, "index.ts"), "utf8")
    const leaked = PACKAGE_INTERNAL_OPERATIONS.filter((op) => new RegExp(String.raw`(^|[\s,{])${op}\s*(,|$)`, "m").test(barrel))
    expect(leaked).toEqual([])

    // Non-vacuous: the barrel really is the surface we think it is.
    expect(barrel).toContain("getTelemetryRuntime")
    expect(barrel).toContain("TELEMETRY_DIMENSION_NAMES")
  })

  test("no production file outside the package deep-imports past the barrel", async () => {
    const roots = await productionSourceRoots()
    const files = (await Promise.all(roots.map((root) => sourceFiles(root)))).flat()
    expect(files.length).toBeGreaterThan(100)

    const violations: Array<string> = []
    for (const file of files) {
      if (file.startsWith(telemetryPackageSrc)) continue
      const deep = deepInternalImports(await readFile(file, "utf8"))
      if (deep.length > 0) violations.push(`${path.relative(repoRoot, file)}: ${deep.join(", ")}`)
    }
    expect(violations).toEqual([])
  })

  test("the package's own modules import each other RELATIVELY (never through its own package name)", async () => {
    // A package file importing its own package by name would resolve back through the barrel —
    // a needless cycle, and it would slip past the boundary guard's relative-only expectation.
    const files = await sourceFiles(telemetryPackageSrc)
    const violations: Array<string> = []
    for (const file of files) {
      const selfReferences = importedSpecifiers(await readFile(file, "utf8")).filter((spec) => spec.startsWith("@hsupu/ghc-proxy-telemetry"))
      if (selfReferences.length > 0) violations.push(`${path.relative(repoRoot, file)}: ${selfReferences.join(", ")}`)
    }
    expect(violations).toEqual([])
  })
})
