/**
 * Guard — the telemetry package has exactly ONE production surface.
 *
 * The registry's lifecycle / record / read free functions (`initRequestTelemetry`,
 * `recordSettledRequest`, `getDimensionBreakdown`, …) are PACKAGE-INTERNAL: production code reaches
 * them only through the assembled `TelemetryRuntime` exported by the barrel, and tests only through
 * the package's explicit `./testing` entry.
 *
 * Parsed with the TypeScript AST (`./source-ast`), not with patterns over source text. Three review
 * rounds of text matching were defeated by ordinary legal syntax — a single-line `export { … }`, an
 * `as` alias, `export *`, comments between tokens, a `}` inside a string, and finally
 * `import { op as x } from "./internal"; export { x }`, which no name-matching scheme can trace at
 * all. Each round only ever covered the mutation its author had just imagined; the parser covers the
 * syntax SPACE.
 *
 * Two independent ways the surface can leak, both covered:
 *  1. the BARREL republishing an operation — under its own name, an alias, a local re-export hop, or
 *     wholesale via `export *`;
 *  2. a consumer DEEP-importing past the barrel — the package's `exports` map is `"./*"`, so every
 *     internal module is reachable and only a guard stops it.
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

import {
  //
  importedModuleSpecifiers,
  parseSource,
  valueExportOrigins,
  valueStarReExports,
} from "./source-ast"

const repoRoot = path.resolve(import.meta.dir, "../..")
const telemetryPackageSrc = path.join(repoRoot, "packages/telemetry/src")

/** The registry operations that must not escape the package, under ANY name. */
const PACKAGE_INTERNAL_OPERATIONS = new Set([
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
])

/**
 * The ONLY package specifiers production code may use. An allowlist, not a list of known-bad
 * subpaths: `packages/telemetry/package.json` exports `"./*"`, so enumerating today's internals
 * would let tomorrow's new module through silently. `/testing` is deliberately absent — test-only.
 */
const ALLOWED_PACKAGE_SPECIFIERS = new Set(["@hsupu/ghc-proxy-telemetry", "@hsupu/ghc-proxy-telemetry/types"])

/**
 * Source roots that must obey the surface: the core tree, every workspace package, AND the frontend
 * — `ui-v4` is a production consumer too (it re-exports the snapshot types), and the easiest one to
 * forget.
 */
async function productionSourceRoots(): Promise<Array<string>> {
  const roots = [path.join(repoRoot, "src"), path.join(repoRoot, "ui-v4/src")]
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
        : entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) ? [resolved]
        : []
      )
    }),
  )
  return nested.flat()
}

/** The registry operations a module publishes, whatever name it publishes them under (empty = compliant). */
function leakedOperations(fileName: string, source: string): Array<string> {
  const sourceFile = parseSource(fileName, source)
  const leaked = valueExportOrigins(sourceFile)
    .filter((origin) => PACKAGE_INTERNAL_OPERATIONS.has(origin.originalName))
    .map((origin) => (origin.exportedAs === origin.originalName ? origin.originalName : `${origin.originalName} as ${origin.exportedAs}`))
  // A value star re-export republishes a whole module at once — a structural leak no name check sees.
  const stars = valueStarReExports(sourceFile).map((module) => `export * from "${module}"`)
  return [...leaked, ...stars]
}

/** The disallowed telemetry-package specifiers a file actually imports at runtime (empty = compliant). */
function forbiddenPackageImports(fileName: string, source: string): Array<string> {
  return [...new Set(importedModuleSpecifiers(parseSource(fileName, source)))]
    .filter((specifier) => specifier === "@hsupu/ghc-proxy-telemetry" || specifier.startsWith("@hsupu/ghc-proxy-telemetry/"))
    .filter((specifier) => !ALLOWED_PACKAGE_SPECIFIERS.has(specifier))
    .sort()
}

describe("telemetry package surface (one production entry point)", () => {
  test("the leak detector covers every way a barrel can republish an operation", () => {
    const leaks = (source: string): Array<string> => leakedOperations("index.ts", source)

    expect(leaks(`export { recordSettledRequest } from "./request-telemetry"`)).toEqual(["recordSettledRequest"])
    // An alias publishes it just as surely — the question is reachability, not the outside name.
    expect(leaks(`export { recordSettledRequest as rec } from "./request-telemetry"`)).toEqual(["recordSettledRequest as rec"])
    // The local-alias hop: no name-matching scheme can trace this, which is why the guard is an AST now.
    expect(leaks(`import { recordSettledRequest as rec } from "./request-telemetry"\nexport { rec }`)).toEqual(["recordSettledRequest as rec"])
    // Wholesale republication — invisible to any per-name check.
    expect(leaks(`export * from "./request-telemetry"`)).toEqual([`export * from "./request-telemetry"`])
    expect(leaks(`export * as registry from "./request-telemetry"`)).toEqual([`export * from "./request-telemetry"`])
    // Comments between tokens, and a `}` inside a string, both defeated the text parser.
    expect(leaks(`export { /* c */ recordSettledRequest } from "./request-telemetry"`)).toEqual(["recordSettledRequest"])
    expect(leaks(`export { recordSettledRequest } from "./x}y"`)).toEqual(["recordSettledRequest"])

    // Negative controls: the barrel's legitimate surface must NOT be flagged.
    expect(leaks(`export { getTelemetryRuntime } from "./runtime"`)).toEqual([])
    expect(leaks(`export type { RequestTelemetrySnapshot } from "./request-telemetry"`)).toEqual([])
    expect(leaks(`export type * from "./types"`)).toEqual([])
    expect(leaks(`export { type TelemetryPaths, installTelemetryDeps } from "./dependencies"`)).toEqual([])
  })

  test("the import detector reads runtime imports only, in every shape", () => {
    const bad = (source: string): Array<string> => forbiddenPackageImports("consumer.ts", source)

    expect(bad(`import { recordSettledRequest } from "@hsupu/ghc-proxy-telemetry/request-telemetry"`)).toEqual(["@hsupu/ghc-proxy-telemetry/request-telemetry"])
    // A subpath nobody enumerated — the package exports "./*", so the allowlist is what protects us.
    expect(bad(`import { internDim } from "@hsupu/ghc-proxy-telemetry/telemetry/dictionary"`)).toEqual(["@hsupu/ghc-proxy-telemetry/telemetry/dictionary"])
    expect(bad(`await import("@hsupu/ghc-proxy-telemetry/testing")`)).toEqual(["@hsupu/ghc-proxy-telemetry/testing"])
    expect(bad(`const x = require("@hsupu/ghc-proxy-telemetry/runtime")`)).toEqual(["@hsupu/ghc-proxy-telemetry/runtime"])
    expect(bad(`import "@hsupu/ghc-proxy-telemetry/telemetry/db"`)).toEqual(["@hsupu/ghc-proxy-telemetry/telemetry/db"])
    // Comments between tokens no longer hide a side-effect import.
    expect(bad(`import /* c */ "@hsupu/ghc-proxy-telemetry/telemetry/dictionary"`)).toEqual(["@hsupu/ghc-proxy-telemetry/telemetry/dictionary"])

    // Negative controls: the two production-legal specifiers, a mention inside a comment/string,
    // and an unrelated package.
    expect(bad(`import { getTelemetryRuntime } from "@hsupu/ghc-proxy-telemetry"`)).toEqual([])
    expect(bad(`import type { RequestTelemetrySnapshot } from "@hsupu/ghc-proxy-telemetry/types"`)).toEqual([])
    expect(bad(`// see @hsupu/ghc-proxy-telemetry/request-telemetry for details`)).toEqual([])
    expect(bad(`const doc = "@hsupu/ghc-proxy-telemetry/runtime"`)).toEqual([])
    expect(bad(`import { getTokenCredentials } from "@hsupu/ghc-proxy-token"`)).toEqual([])
  })

  test("the barrel publishes no registry operation", async () => {
    const barrelPath = path.join(telemetryPackageSrc, "index.ts")
    const barrel = await readFile(barrelPath, "utf8")
    expect(leakedOperations(barrelPath, barrel)).toEqual([])

    // Non-vacuous: the parser really did read this barrel's surface.
    const exported = new Set(valueExportOrigins(parseSource(barrelPath, barrel)).map((origin) => origin.exportedAs))
    expect(exported.has("getTelemetryRuntime")).toBe(true)
    expect(exported.has("TELEMETRY_DIMENSION_NAMES")).toBe(true)
  })

  test("no production file imports anything but the barrel and the type barrel", async () => {
    const roots = await productionSourceRoots()
    const files = (await Promise.all(roots.map((root) => sourceFiles(root)))).flat()
    expect(files.length).toBeGreaterThan(100)

    const violations: Array<string> = []
    for (const file of files) {
      if (file.startsWith(telemetryPackageSrc)) continue
      const forbidden = forbiddenPackageImports(file, await readFile(file, "utf8"))
      if (forbidden.length > 0) violations.push(`${path.relative(repoRoot, file)}: ${forbidden.join(", ")}`)
    }
    expect(violations).toEqual([])
  })

  test("the package's own modules import each other RELATIVELY (never through its own package name)", async () => {
    // A package file importing its own package by name would resolve back through the barrel —
    // a needless cycle, and it would slip past the boundary guard's relative-only expectation.
    const files = await sourceFiles(telemetryPackageSrc)
    const violations: Array<string> = []
    for (const file of files) {
      const sourceFile = parseSource(file, await readFile(file, "utf8"))
      const selfReferences = importedModuleSpecifiers(sourceFile).filter((spec) => spec.startsWith("@hsupu/ghc-proxy-telemetry"))
      if (selfReferences.length > 0) violations.push(`${path.relative(repoRoot, file)}: ${selfReferences.join(", ")}`)
    }
    expect(violations).toEqual([])
  })
})
