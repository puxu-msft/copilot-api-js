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
