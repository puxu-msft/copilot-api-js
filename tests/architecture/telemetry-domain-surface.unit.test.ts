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
 *  1. the BARREL publishing something it should not;
 *  2. a consumer DEEP-IMPORTING past the barrel — the package's `exports` map is `"./*"`, so every
 *     internal module is reachable and only a guard stops it.
 *
 * For (1) the check is an exact ALLOWLIST of the barrel's public names rather than a blocklist of
 * registry operations. Chasing operations was a losing game: each review round traced provenance one
 * level deeper — through aliases, a local re-export hop, `export default`, a namespace object, a
 * `const` wrapper, a cross-file two-hop chain — and each depth only closed the bypass just
 * demonstrated. An allowlist inverts the burden: ANY new public name fails until someone adds it
 * here deliberately, whatever mechanism created it. Value star re-exports stay forbidden outright,
 * since they are the one form a single file cannot enumerate.
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
  allModuleSpecifiers,
  parseSource,
  publicExportNames,
  valueStarReExports,
} from "./source-ast"

const repoRoot = path.resolve(import.meta.dir, "../..")
const telemetryPackageSrc = path.join(repoRoot, "packages/telemetry/src")

/**
 * The barrel's COMPLETE public surface. Adding a line here is the deliberate act of widening the
 * telemetry package's contract — which is exactly the review this guard exists to force.
 *
 * Everything listed is either a type, a metadata constant, the assembled runtime, the injected-port
 * contract, or a SQLite tier read primitive. Notably absent: every registry lifecycle/record/read
 * operation (`initRequestTelemetry`, `recordSettledRequest`, `getDimensionBreakdown`, …) — those are
 * reachable only through the runtime in production and through `./testing` in tests.
 */
const ALLOWED_BARREL_EXPORTS = new Set([
  // Composition root: the runtime + its process-singleton lifecycle.
  "createTelemetryRuntime",
  "getTelemetryRuntime",
  "installTelemetryRuntime",
  "peekTelemetryRuntime",
  "resetTelemetryRuntimeForTests",
  "TelemetryRuntime",
  // Injected ports (the domain's external contract).
  "getTelemetryDeps",
  "installTelemetryDeps",
  "TelemetryConfigSubscription",
  "TelemetryConfigView",
  "TelemetryPaths",
  "TelemetryRuntimeDependencies",
  // Dimension NAME registry (the entry/ctx-free half).
  "CAPPED_DIMENSION_NAMES",
  "TELEMETRY_DIMENSION_NAMES",
  "TELEMETRY_DIMENSION_SPECS",
  "TelemetryDimensionCardinality",
  "TelemetryDimensionName",
  "TelemetryDimensionSpec",
  "ThinkingBlockCounts",
  // Registry metadata constants (no lifecycle).
  "DEFAULT_BREAKDOWN_LIMIT",
  "TELEMETRY_HISTOGRAMS",
  "TELEMETRY_MEASURE_NAMES",
  // SQLite store: the handle type + the tier read primitives /api/stats serves from.
  "TelemetryDatabase",
  "DistributionSummary",
  "readCumulativeBreakdown",
  "readCumulativeSketchQuantiles",
  "readJsonBackfillBoundaryTs",
  "readTierBreakdown",
  "readTierSketchQuantiles",
  "TierBreakdownResult",
  "TierKeyCounters",
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

/** Public names the barrel exposes beyond its declared contract (empty = compliant). */
function unlistedBarrelExports(fileName: string, source: string): Array<string> {
  const sourceFile = parseSource(fileName, source)
  const unlisted = publicExportNames(sourceFile).filter((name) => !ALLOWED_BARREL_EXPORTS.has(name))
  // A value star re-export republishes a whole module at once and cannot be enumerated from this
  // file at all — the one form the allowlist cannot see, so it is forbidden outright.
  const stars = valueStarReExports(sourceFile).map((module) => `export * from "${module}"`)
  return [...unlisted, ...stars].sort()
}

/**
 * The disallowed telemetry-package specifiers a file imports (empty = compliant). Uses ALL
 * specifiers, not just runtime ones: a `import type { … } from "…/request-telemetry"` bypasses the
 * public type barrel just as surely as a value import bypasses the runtime one.
 */
function forbiddenPackageImports(fileName: string, source: string): Array<string> {
  return [...new Set(allModuleSpecifiers(parseSource(fileName, source)))]
    .filter((specifier) => specifier === "@hsupu/ghc-proxy-telemetry" || specifier.startsWith("@hsupu/ghc-proxy-telemetry/"))
    .filter((specifier) => !ALLOWED_PACKAGE_SPECIFIERS.has(specifier))
    .sort()
}

describe("telemetry package surface (one production entry point)", () => {
  test("the allowlist check catches a new public name however it was created", () => {
    const unlisted = (source: string): Array<string> => unlistedBarrelExports("index.ts", source)

    // Each of these was a separate bypass across three review rounds; one mechanism closes them all,
    // because the question is no longer "where did this name come from" but "is it on the contract".
    expect(unlisted(`export { recordSettledRequest } from "./request-telemetry"`)).toEqual(["recordSettledRequest"])
    expect(unlisted(`export { recordSettledRequest as rec } from "./request-telemetry"`)).toEqual(["rec"])
    expect(unlisted(`import { recordSettledRequest as rec } from "./request-telemetry"\nexport { rec }`)).toEqual(["rec"])
    expect(unlisted(`import { recordSettledRequest } from "./request-telemetry"\nexport default recordSettledRequest`)).toEqual(["default"])
    expect(unlisted(`import * as registry from "./request-telemetry"\nexport { registry }`)).toEqual(["registry"])
    expect(unlisted(`import { recordSettledRequest } from "./request-telemetry"\nexport const harmless = recordSettledRequest`)).toEqual(["harmless"])
    // The cross-file two-hop chain: the barrel need not know where `harmless` comes from to reject it.
    expect(unlisted(`export { harmless } from "./dimension-names"`)).toEqual(["harmless"])
    // Star re-exports are the one form a single file cannot enumerate — forbidden outright.
    expect(unlisted(`export * from "./request-telemetry"`)).toEqual([`export * from "./request-telemetry"`])
    expect(unlisted(`export * as registry from "./request-telemetry"`)).toEqual([`export * from "./request-telemetry"`])
    // Comments between tokens and a `}` inside a string defeated the earlier text parser.
    expect(unlisted(`export { /* c */ recordSettledRequest } from "./request-telemetry"`)).toEqual(["recordSettledRequest"])
    expect(unlisted(`export { recordSettledRequest } from "./x}y"`)).toEqual(["recordSettledRequest"])

    // Negative controls: the declared contract must pass, values and types alike.
    expect(unlisted(`export { getTelemetryRuntime } from "./runtime"`)).toEqual([])
    expect(unlisted(`export type { ThinkingBlockCounts } from "./dimension-names"`)).toEqual([])
    expect(unlisted(`export type * from "./types"`)).toEqual([])
    expect(unlisted(`export { type TelemetryPaths, installTelemetryDeps } from "./dependencies"`)).toEqual([])
  })

  test("the import detector reads every import shape, including type-only", () => {
    const bad = (source: string): Array<string> => forbiddenPackageImports("consumer.ts", source)

    expect(bad(`import { recordSettledRequest } from "@hsupu/ghc-proxy-telemetry/request-telemetry"`)).toEqual(["@hsupu/ghc-proxy-telemetry/request-telemetry"])
    // A subpath nobody enumerated — the package exports "./*", so the allowlist is what protects us.
    expect(bad(`import { internDim } from "@hsupu/ghc-proxy-telemetry/telemetry/dictionary"`)).toEqual(["@hsupu/ghc-proxy-telemetry/telemetry/dictionary"])
    // A TYPE-ONLY deep import bypasses the public type barrel just as surely — the frontend must go
    // through `/types`, not reach into the registry module.
    expect(bad(`import type { TelemetryUsage } from "@hsupu/ghc-proxy-telemetry/request-telemetry"`)).toEqual(["@hsupu/ghc-proxy-telemetry/request-telemetry"])
    expect(bad(`await import("@hsupu/ghc-proxy-telemetry/testing")`)).toEqual(["@hsupu/ghc-proxy-telemetry/testing"])
    expect(bad(`const x = require("@hsupu/ghc-proxy-telemetry/runtime")`)).toEqual(["@hsupu/ghc-proxy-telemetry/runtime"])
    expect(bad(`import "@hsupu/ghc-proxy-telemetry/telemetry/db"`)).toEqual(["@hsupu/ghc-proxy-telemetry/telemetry/db"])
    expect(bad(`import /* c */ "@hsupu/ghc-proxy-telemetry/telemetry/dictionary"`)).toEqual(["@hsupu/ghc-proxy-telemetry/telemetry/dictionary"])

    // Negative controls: the two production-legal specifiers, a mention inside a comment/string,
    // and an unrelated package.
    expect(bad(`import { getTelemetryRuntime } from "@hsupu/ghc-proxy-telemetry"`)).toEqual([])
    expect(bad(`import type { RequestTelemetrySnapshot } from "@hsupu/ghc-proxy-telemetry/types"`)).toEqual([])
    expect(bad(`// see @hsupu/ghc-proxy-telemetry/request-telemetry for details`)).toEqual([])
    expect(bad(`const doc = "@hsupu/ghc-proxy-telemetry/runtime"`)).toEqual([])
    expect(bad(`import { getTokenCredentials } from "@hsupu/ghc-proxy-token"`)).toEqual([])
  })

  test("the real barrel publishes exactly its declared contract", async () => {
    const barrelPath = path.join(telemetryPackageSrc, "index.ts")
    const barrel = await readFile(barrelPath, "utf8")
    expect(unlistedBarrelExports(barrelPath, barrel)).toEqual([])

    // Non-vacuous in BOTH directions: the parser really read this barrel (it found the anchors), and
    // the allowlist carries no stale entries the barrel no longer exports.
    const published = new Set(publicExportNames(parseSource(barrelPath, barrel)))
    expect(published.has("getTelemetryRuntime")).toBe(true)
    expect(published.has("TELEMETRY_DIMENSION_NAMES")).toBe(true)
    const stale = [...ALLOWED_BARREL_EXPORTS].filter((name) => !published.has(name))
    expect(stale).toEqual([])
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
      const selfReferences = allModuleSpecifiers(sourceFile).filter((spec) => spec.startsWith("@hsupu/ghc-proxy-telemetry"))
      if (selfReferences.length > 0) violations.push(`${path.relative(repoRoot, file)}: ${selfReferences.join(", ")}`)
    }
    expect(violations).toEqual([])
  })
})
