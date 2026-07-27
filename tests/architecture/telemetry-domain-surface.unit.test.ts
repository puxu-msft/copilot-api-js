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

/**
 * The ONLY package specifiers production code may use. An allowlist, not a list of known-bad
 * subpaths: `packages/telemetry/package.json` exports `"./*"`, so every internal module is
 * reachable and enumerating today's five would let tomorrow's sixth through silently.
 *  - the barrel is the production surface;
 *  - `/types` is the pure-type barrel the frontend re-exports from.
 * Notably `/testing` is NOT here — it is the test-only entry.
 */
const ALLOWED_PACKAGE_SPECIFIERS = new Set(["@hsupu/ghc-proxy-telemetry", "@hsupu/ghc-proxy-telemetry/types"])

/**
 * Source roots that must obey the surface: the core tree, every workspace package, AND the
 * frontend — `ui-v4` is a production consumer too (it re-exports the snapshot types), so leaving it
 * out would let the surface leak through the one consumer that is easiest to forget.
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

/** Every specifier a file imports from, in any import form (static / side-effect / dynamic / require). */
function importedSpecifiers(source: string): Array<string> {
  const re = /(?:\bfrom|\bimport|\brequire)\s*(?:\(\s*)?["']([^"']+)["']/g
  return [...source.matchAll(re)].map((match) => match[1])
}

/** The disallowed telemetry-package specifiers a file reaches for (empty = compliant). */
function forbiddenPackageImports(source: string): Array<string> {
  return [...new Set(importedSpecifiers(source))]
    .filter((specifier) => specifier === "@hsupu/ghc-proxy-telemetry" || specifier.startsWith("@hsupu/ghc-proxy-telemetry/"))
    .filter((specifier) => !ALLOWED_PACKAGE_SPECIFIERS.has(specifier))
    .sort()
}

/**
 * Every name a module re-exports in `export { … }` / `export type { … }` blocks — BOTH sides of an
 * `as` rename. Brace-matched and comma-split rather than pattern-matched: the previous regex
 * demanded a comma or line end after the name, so the ordinary single-line form
 * `export { recordSettledRequest } from "./x"` slipped through and the guard passed while an
 * operation WAS public (found in merged-state review).
 *
 * Both sides matter because the question is "is this operation reachable from outside", not "what is
 * it called out there": `export { recordSettledRequest as rec }` publishes the operation just as
 * surely, and reporting only `rec` would be the same false green in a new costume.
 */
function exportedNames(source: string): Array<string> {
  const names: Array<string> = []
  const re = /\bexport\s+(?:type\s+)?\{/g
  for (const match of source.matchAll(re)) {
    const open = match.index + match[0].length - 1
    const close = source.indexOf("}", open)
    if (close === -1) continue
    // Drop `//` line comments first — this codebase's import/export blocks open with a bare `//`
    // (the perfectionist sort anchor), which would otherwise glue onto the first name.
    const block = source
      .slice(open + 1, close)
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n")
    for (const part of block.split(",")) {
      // `type X` inside a value block is a type specifier; `a as b` contributes BOTH a and b.
      const specifier = part.trim().replace(/^type\s+/, "")
      for (const side of specifier.split(/\s+as\s+/)) {
        const name = side.trim()
        if (name && /^\w+$/.test(name)) names.push(name)
      }
    }
  }
  return names
}

/**
 * VALUE star re-exports (`export * from "./x"` / `export * as ns from "./x"`). One of these in the
 * barrel would republish every registry operation at once while a NAME-based check sees nothing at
 * all — the largest hole this guard can have, and invisible to {@link exportedNames} by
 * construction. `export type * from "./types"` is deliberately not matched: type-only, so it can
 * carry no operation.
 */
function valueStarReExports(source: string): Array<string> {
  return [...source.matchAll(/^[^\S\n]*export\s+(?:type\s+)?\*[^\n]*/gm)].map((match) => match[0].trim()).filter((line) => !/^export\s+type\s+\*/.test(line))
}

describe("telemetry package surface (one production entry point)", () => {
  test("the import detector bites on every reachable internal subpath, not just today's five", () => {
    expect(forbiddenPackageImports(`import { recordSettledRequest } from "@hsupu/ghc-proxy-telemetry/request-telemetry"`)).toEqual([
      "@hsupu/ghc-proxy-telemetry/request-telemetry",
    ])
    // The allowlist's reason for existing: a subpath nobody enumerated (the package exports "./*").
    expect(forbiddenPackageImports(`import { internDim } from "@hsupu/ghc-proxy-telemetry/telemetry/dictionary"`)).toEqual([
      "@hsupu/ghc-proxy-telemetry/telemetry/dictionary",
    ])
    // Non-`from` import shapes must also be flagged.
    expect(forbiddenPackageImports(`await import("@hsupu/ghc-proxy-telemetry/testing")`)).toEqual(["@hsupu/ghc-proxy-telemetry/testing"])
    expect(forbiddenPackageImports(`const x = require("@hsupu/ghc-proxy-telemetry/runtime")`)).toEqual(["@hsupu/ghc-proxy-telemetry/runtime"])

    // Negative control: the two production-legal specifiers.
    expect(forbiddenPackageImports(`import { getTelemetryRuntime } from "@hsupu/ghc-proxy-telemetry"`)).toEqual([])
    expect(forbiddenPackageImports(`import type { RequestTelemetrySnapshot } from "@hsupu/ghc-proxy-telemetry/types"`)).toEqual([])
    // …and an unrelated package is none of this guard's business.
    expect(forbiddenPackageImports(`import { getTokenCredentials } from "@hsupu/ghc-proxy-token"`)).toEqual([])
  })

  test("the export parser reads real export syntax (every form that could hide an operation)", () => {
    // Regression control for the false green found in merged-state review: this exact line was added
    // to the barrel and the guard stayed green.
    expect(exportedNames(`export { recordSettledRequest } from "./request-telemetry"`)).toEqual(["recordSettledRequest"])
    // An alias publishes the operation just as surely — BOTH sides must be reported, or renaming is
    // a trivial bypass (found by probing the parser with legal syntax rather than trusting it).
    expect(exportedNames(`export { recordSettledRequest as rec } from "./x"`)).toEqual(["recordSettledRequest", "rec"])
    expect(exportedNames(`export {\n  recordSettledRequest, // trailing comment\n  getTelemetryDb,\n} from "./x"`)).toEqual([
      "recordSettledRequest",
      "getTelemetryDb",
    ])
    expect(exportedNames(`export {\n  //\n  getTelemetryRuntime,\n} from "./runtime"`)).toEqual(["getTelemetryRuntime"])
    expect(exportedNames(`export { initRequestTelemetry as init } from "./request-telemetry"`)).toEqual(["initRequestTelemetry", "init"])
    expect(exportedNames(`export type { TelemetryRuntime } from "./runtime"`)).toEqual(["TelemetryRuntime"])
    expect(exportedNames(`export { type TelemetryPaths, installTelemetryDeps } from "./dependencies"`)).toEqual(["TelemetryPaths", "installTelemetryDeps"])
  })

  test("the star-re-export detector flags the one-line way to republish everything", () => {
    expect(valueStarReExports(`export * from "./request-telemetry"`)).toEqual([`export * from "./request-telemetry"`])
    expect(valueStarReExports(`export * as registry from "./request-telemetry"`)).toEqual([`export * as registry from "./request-telemetry"`])
    // Type-only stars carry no operation and are the barrel's legitimate `./types` re-export.
    expect(valueStarReExports(`export type * from "./types"`)).toEqual([])
  })

  test("the barrel exports no registry OPERATION (only types, constants, the runtime and the tier reads)", async () => {
    const barrel = await readFile(path.join(telemetryPackageSrc, "index.ts"), "utf8")
    const exported = new Set(exportedNames(barrel))
    expect(PACKAGE_INTERNAL_OPERATIONS.filter((op) => exported.has(op))).toEqual([])

    // A value star re-export would republish every operation while the name check above sees
    // nothing — so it is forbidden outright rather than name-checked.
    expect(valueStarReExports(barrel)).toEqual([])

    // Non-vacuous: the parser really did read this barrel's surface.
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
      const forbidden = forbiddenPackageImports(await readFile(file, "utf8"))
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
      const selfReferences = importedSpecifiers(await readFile(file, "utf8")).filter((spec) => spec.startsWith("@hsupu/ghc-proxy-telemetry"))
      if (selfReferences.length > 0) violations.push(`${path.relative(repoRoot, file)}: ${selfReferences.join(", ")}`)
    }
    expect(violations).toEqual([])
  })
})
