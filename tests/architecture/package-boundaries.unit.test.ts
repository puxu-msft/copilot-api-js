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
} from "./source-ast"

const repoRoot = path.resolve(import.meta.dir, "../..")

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

// A file in `foundation` is a leaf: it may only import foundation-internal
// modules (via RELATIVE `./` paths, per the same-package convention) or bare
// external packages (node:, npm). It must NEVER import a sibling workspace
// package (`@hsupu/ghc-proxy-{core,server,cli}`) nor use the `~/` alias at all
// — `~/` resolves into the app/core tree, so any `~/` inside foundation is a
// leak. (Files OUTSIDE foundation keep importing `~/lib/<x>` via the
// transitional alias; that is fine — this guard only governs foundation's own
// source.)
//
// `importsSpecifier` matches a specifier in ANY import form — static
// `from "X"`, side-effect `import "X"`, dynamic `import("X")`, or `require("X")`
// — so a non-`from` import shape cannot silently bypass a package boundary.
// `specBody` is the regex body of the quoted specifier (e.g. `~\/`).
function importsSpecifier(source: string, specBody: string): boolean {
  return new RegExp(String.raw`(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']${specBody}`).test(source)
}
const SIBLING_CORE_SERVER_CLI = String.raw`@hsupu\/ghc-proxy-(?:core|server|cli)`
const ROOT_ALIAS = String.raw`~\/`

function foundationHasForbiddenImport(source: string): boolean {
  return importsSpecifier(source, SIBLING_CORE_SERVER_CLI) || importsSpecifier(source, ROOT_ALIAS)
}

// A file in the `token` package may import ONLY: token-internal modules (RELATIVE
// `./` paths), the foundation package (`@hsupu/ghc-proxy-foundation[/…]`), or
// bare external packages (node:, npm — e.g. consola). It must NEVER import a
// sibling core/server/cli package, nor use the `~/` alias at all (which resolves
// into the core tree) — the whole point of the extraction is a machine-verified
// zero-dependency-on-core boundary. (Consumers OUTSIDE the package keep importing
// `~/lib/token[/…]` via the transitional alias; this guard governs only the
// package's own source.)
function tokenHasForbiddenImport(source: string): boolean {
  return importsSpecifier(source, SIBLING_CORE_SERVER_CLI) || importsSpecifier(source, ROOT_ALIAS)
}

// The `telemetry` package uses an ALLOWLIST rather than the token/foundation denylist: those two
// only reject `@hsupu/ghc-proxy-{core,server,cli}`, which would silently ADMIT any other sibling
// package (e.g. `@hsupu/ghc-proxy-token`) as the workspace grows. Telemetry may import ONLY:
// package-internal modules (relative `./`/`../`), the foundation package, `node:` builtins, and the
// externals its package.json declares (`consola`, `@datadog/sketches-js`). Everything else — every
// other `@hsupu/*`, every `~/` alias, every undeclared bare package — is a boundary violation.
const TELEMETRY_ALLOWED_EXTERNALS = new Set(["consola", "@datadog/sketches-js"])

/**
 * Parsed with the TypeScript AST, not a source regex. The text version shared a blind spot with the
 * surface guard: `import /* c *\/ "~/lib/state"` (a comment between the tokens) slipped past
 * `\s*\(?\s*`, and a specifier mentioned inside a comment or string produced a false positive.
 *
 * Deliberately checks TYPE-ONLY imports too — a type edge still couples the package to core and
 * still counts as a cycle edge in the madge SCC snapshot (severing exactly such an edge is what T4
 * had to do to get telemetry out of the SCC), so a boundary that ignored them would call a coupled
 * package clean.
 */
function telemetryForbiddenSpecifiers(source: string, fileName = "telemetry.ts"): Array<string> {
  const forbidden: Array<string> = []
  for (const specifier of allModuleSpecifiers(parseSource(fileName, source))) {
    if (specifier.startsWith("./") || specifier.startsWith("../")) continue
    if (specifier.startsWith("node:")) continue
    if (specifier === "@hsupu/ghc-proxy-foundation" || specifier.startsWith("@hsupu/ghc-proxy-foundation/")) continue
    // A declared external, imported either bare or by subpath (`consola/x`).
    const externalRoot = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]
    if (TELEMETRY_ALLOWED_EXTERNALS.has(externalRoot)) continue
    forbidden.push(specifier)
  }
  return forbidden
}

describe("workspace packages", () => {
  test("root workspaces includes packages/*", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      workspaces?: Array<string>
    }
    expect(pkg.workspaces).toContain("packages/*")
  })

  test("foundation package.json declares correct name and is private", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "packages/foundation/package.json"), "utf8")) as { name?: string; private?: boolean }
    expect(pkg.name).toBe("@hsupu/ghc-proxy-foundation")
    expect(pkg.private).toBe(true)
  })

  test("token package.json declares correct name, is private, and declares its external deps", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "packages/token/package.json"), "utf8")) as {
      name?: string
      private?: boolean
      dependencies?: Record<string, string>
    }
    expect(pkg.name).toBe("@hsupu/ghc-proxy-token")
    expect(pkg.private).toBe(true)
    // Must EXPLICITLY declare its runtime deps (single-lockfile hoist would
    // otherwise hide a missing declaration — foundation's empty-deps is not the
    // template here; the token package actually uses consola + foundation).
    expect(pkg.dependencies?.consola).toBeDefined()
    expect(pkg.dependencies?.["@hsupu/ghc-proxy-foundation"]).toBeDefined()
  })
})

describe("package import boundaries", () => {
  // Positive control: prove the detector actually flags forbidden imports,
  // otherwise a green guard over an empty package proves nothing.
  test("foundation boundary detector flags forbidden imports (positive control)", () => {
    expect(foundationHasForbiddenImport('import { state } from "~/lib/state"')).toBe(true)
    expect(foundationHasForbiddenImport('import { x } from "@hsupu/ghc-proxy-core"')).toBe(true)
    expect(foundationHasForbiddenImport('import { d } from "~/lib/util/abortable-delay"')).toBe(true)
    // Non-`from` import shapes must also be flagged (side-effect / dynamic / require):
    expect(foundationHasForbiddenImport('import "~/lib/state"')).toBe(true)
    expect(foundationHasForbiddenImport('const s = await import("~/lib/state")')).toBe(true)
    expect(foundationHasForbiddenImport('const s = require("~/lib/state")')).toBe(true)
    // foundation-internal relative + bare external imports are allowed:
    expect(foundationHasForbiddenImport('import { s } from "./stream"')).toBe(false)
    expect(foundationHasForbiddenImport('import { z } from "node:zlib"')).toBe(false)
  })

  test("foundation package imports nothing forbidden (relative + bare external only)", async () => {
    const root = path.join(repoRoot, "packages/foundation/src")
    const files = await sourceFiles(root)
    for (const file of files) {
      const source = await readFile(file, "utf8")
      expect(foundationHasForbiddenImport(source), file).toBe(false)
    }
  })

  // Positive control: prove the token detector fires on core imports and the
  // `~/` alias, and does NOT fire on the allowed forms (foundation package,
  // relative, bare external). A green scan over the package without this proves
  // nothing (the exact import forms the extraction removed — `~/lib/state`,
  // `~/lib/transport/upstream-fetch`, `~/lib/config/paths` — must be flagged).
  test("token boundary detector flags forbidden imports (positive control)", () => {
    expect(tokenHasForbiddenImport('import { state } from "~/lib/state"')).toBe(true)
    expect(tokenHasForbiddenImport('import { upstreamFetch } from "~/lib/transport/upstream-fetch"')).toBe(true)
    expect(tokenHasForbiddenImport('import { PATHS } from "~/lib/config/paths"')).toBe(true)
    expect(tokenHasForbiddenImport('import { x } from "@hsupu/ghc-proxy-core"')).toBe(true)
    // Non-`from` import shapes must also be flagged (side-effect / dynamic / require):
    expect(tokenHasForbiddenImport('import "~/lib/state"')).toBe(true)
    expect(tokenHasForbiddenImport('const p = await import("~/lib/config/paths")')).toBe(true)
    expect(tokenHasForbiddenImport('const p = require("~/lib/config/paths")')).toBe(true)
    // Allowed: foundation package (any subpath), relative, bare external, node:.
    expect(tokenHasForbiddenImport('import { s } from "@hsupu/ghc-proxy-foundation/sensitive-output"')).toBe(false)
    expect(tokenHasForbiddenImport('import { standardHeaders } from "@hsupu/ghc-proxy-foundation/ghc-http-primitives"')).toBe(false)
    expect(tokenHasForbiddenImport('import { getGitHubUser } from "../github-client"')).toBe(false)
    expect(tokenHasForbiddenImport('import consola from "consola"')).toBe(false)
    expect(tokenHasForbiddenImport('import fs from "node:fs/promises"')).toBe(false)
  })

  test("token package imports nothing forbidden (relative + foundation + bare external only)", async () => {
    const root = path.join(repoRoot, "packages/token/src")
    const files = await sourceFiles(root)
    for (const file of files) {
      const source = await readFile(file, "utf8")
      expect(tokenHasForbiddenImport(source), file).toBe(false)
    }
  })

  // Positive control for the ALLOWLIST detector: it must flag every import form the peel removed
  // (core state, config paths, the sibling token package, an undeclared external) and must NOT flag
  // the four allowed shapes. A green scan without this proves nothing.
  test("telemetry boundary detector flags forbidden imports (positive control)", () => {
    expect(telemetryForbiddenSpecifiers('import { state } from "~/lib/state"')).toEqual(["~/lib/state"])
    expect(telemetryForbiddenSpecifiers('import { PATHS } from "~/lib/config/paths"')).toEqual(["~/lib/config/paths"])
    expect(telemetryForbiddenSpecifiers('import { x } from "~/lib/observability/telemetry-dimensions"')).toEqual(["~/lib/observability/telemetry-dimensions"])
    expect(telemetryForbiddenSpecifiers('import type { UsageData } from "~/lib/history/store"')).toEqual(["~/lib/history/store"])
    expect(telemetryForbiddenSpecifiers('import { x } from "@hsupu/ghc-proxy-core"')).toEqual(["@hsupu/ghc-proxy-core"])
    // The allowlist's reason for existing: a SIBLING package the denylist would have admitted.
    expect(telemetryForbiddenSpecifiers('import { getTokenCredentials } from "@hsupu/ghc-proxy-token"')).toEqual(["@hsupu/ghc-proxy-token"])
    // An external the package.json does not declare (a single lockfile would otherwise hoist it silently).
    expect(telemetryForbiddenSpecifiers('import { z } from "zod"')).toEqual(["zod"])
    // Non-`from` import shapes must also be flagged.
    expect(telemetryForbiddenSpecifiers('import "~/lib/state"')).toEqual(["~/lib/state"])
    // A comment between the tokens defeated the previous regex version of this detector.
    expect(telemetryForbiddenSpecifiers('import /* c */ "~/lib/state"')).toEqual(["~/lib/state"])
    // A TYPE-ONLY import is still a boundary violation (it is a real cycle edge — see T4).
    expect(telemetryForbiddenSpecifiers('import type { HistoryEntryData } from "~/lib/context/types"')).toEqual(["~/lib/context/types"])
    expect(telemetryForbiddenSpecifiers('export type { UsageData } from "~/lib/history/store"')).toEqual(["~/lib/history/store"])
    // …and a specifier that only appears in a comment or a string is NOT an import (no false positive).
    expect(telemetryForbiddenSpecifiers('// we used to import "~/lib/state" here')).toEqual([])
    expect(telemetryForbiddenSpecifiers('const doc = "~/lib/state"')).toEqual([])
    expect(telemetryForbiddenSpecifiers('const p = await import("~/lib/config/paths")')).toEqual(["~/lib/config/paths"])
    expect(telemetryForbiddenSpecifiers('const p = require("~/lib/config/paths")')).toEqual(["~/lib/config/paths"])

    // Allowed: relative (both directions), foundation (bare + subpath), declared externals, node:.
    expect(telemetryForbiddenSpecifiers('import { openTelemetryDb } from "./db"')).toEqual([])
    expect(telemetryForbiddenSpecifiers('import { x } from "../dimension-names"')).toEqual([])
    expect(telemetryForbiddenSpecifiers('import { createSerializedAsyncFn } from "@hsupu/ghc-proxy-foundation/atomic-fs"')).toEqual([])
    expect(telemetryForbiddenSpecifiers('import { createDatabase } from "@hsupu/ghc-proxy-foundation/sqlite/driver"')).toEqual([])
    expect(telemetryForbiddenSpecifiers('import consola from "consola"')).toEqual([])
    expect(telemetryForbiddenSpecifiers('import { DDSketch } from "@datadog/sketches-js"')).toEqual([])
    expect(telemetryForbiddenSpecifiers('import fs from "node:fs/promises"')).toEqual([])
  })

  test("telemetry package imports nothing forbidden (relative + foundation + declared externals only)", async () => {
    const root = path.join(repoRoot, "packages/telemetry/src")
    const files = await sourceFiles(root)
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      expect(telemetryForbiddenSpecifiers(await readFile(file, "utf8"), file), file).toEqual([])
    }
  })

  test("telemetry package.json declares its identity + every external it imports", async () => {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "packages/telemetry/package.json"), "utf8")) as {
      name?: string
      private?: boolean
      dependencies?: Record<string, string>
    }
    expect(manifest.name).toBe("@hsupu/ghc-proxy-telemetry")
    expect(manifest.private).toBe(true)
    // A single hoisted lockfile makes an undeclared dependency resolve anyway — declaring them is
    // the only thing that keeps the package independently installable.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["@datadog/sketches-js", "@hsupu/ghc-proxy-foundation", "consola"])
  })

  // core (src/lib, src/routes, src/server.ts) is BELOW cli in the layer DAG:
  // it must never import the cli package. (cli → core/server is legal; this
  // guards the reverse.) Detects both the transitional `~/<clifile>` alias and
  // the eventual `@hsupu/ghc-proxy-cli` package name.
  test("core/server source never imports the cli package", async () => {
    const CLI_FILES = ["main", "auth", "debug", "logout", "list-claude-code", "setup-claude-code", "setup-codex", "start"]
    const importsCli = (source: string): boolean => {
      if (/from ["']@hsupu\/ghc-proxy-cli/.test(source)) return true
      const aliasCli = new RegExp(String.raw`from ["']~/(?:${CLI_FILES.join("|")})["']`)
      return aliasCli.test(source)
    }
    // Positive control: the detector must actually fire.
    expect(importsCli('import { start } from "~/start"')).toBe(true)
    expect(importsCli('import { x } from "@hsupu/ghc-proxy-cli"')).toBe(true)
    expect(importsCli('import { y } from "~/lib/state"')).toBe(false)

    for (const dir of ["src/lib", "src/routes"]) {
      const files = await sourceFiles(path.join(repoRoot, dir))
      for (const file of files) {
        expect(importsCli(await readFile(file, "utf8")), file).toBe(false)
      }
    }
    // src/server.ts (stays in src, belongs to the server package)
    expect(importsCli(await readFile(path.join(repoRoot, "src/server.ts"), "utf8"))).toBe(false)
  })
})

/**
 * The post-header abort-provenance gap counter lives in ONE helper in the driver. A bare
 * `{ kind: "stream-error" }` literal bypasses it, and the bypass is invisible: the outcome is
 * still correct, only the counter under-reports — and an under-reporting gap detector reads as
 * "no gaps", which is worse than not having one. (That is not hypothetical: the counter's first
 * home missed the Responses upstream-WebSocket leg entirely.)
 */
describe("driver: stream-error outcomes go through the counting helper", () => {
  test('no bare `kind: "stream-error"` object literal outside `streamErrorOutcome`', async () => {
    const source = await Bun.file(new URL("../../src/lib/pipeline/driver.ts", import.meta.url)).text()
    const lines = source.split("\n")

    // Positive control: the helper itself must be present and must be the one place that mints it,
    // otherwise this test would pass on a file that simply no longer produces the outcome at all.
    const helperLine = lines.findIndex((line) => line.includes("function streamErrorOutcome("))
    expect(helperLine).toBeGreaterThan(-1)

    const offenders = lines
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line }) => /kind:\s*"stream-error"/.test(line))
      .filter(({ lineNumber }) => lineNumber !== helperLine + 3) // the helper's own return
      .filter(({ line }) => !line.trimStart().startsWith("*")) // JSDoc prose
      .filter(({ line }) => !line.includes("function streamErrorOutcome("))

    expect(offenders.map(({ line, lineNumber }) => `${lineNumber}: ${line.trim()}`)).toEqual([])
  })
})
