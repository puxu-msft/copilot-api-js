import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import {
  //
  readdir,
  readFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import ts from "typescript"

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

/**
 * Parsed with the AST, not a source regex — for the same reason `telemetryForbiddenSpecifiers` is:
 * the text form reports a specifier that merely appears in a COMMENT. `state.ts` moved into
 * foundation carrying a comment that reads `existing \`import … from "~/lib/state"\` consumers keep
 * working`, and the regex called that a boundary violation. A guard that cannot tell an import from
 * a sentence about an import trains people to reword comments, which is the opposite of the point.
 */
function foundationHasForbiddenImport(source: string, fileName = "foundation.ts"): boolean {
  return allModuleSpecifiers(parseSource(fileName, source)).some(
    (specifier) => specifier.startsWith("~/") || /^@hsupu\/ghc-proxy-(?:core|server|cli)(?:\/|$)/.test(specifier),
  )
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

/**
 * The state unit — `state.ts`, `state-defaults.ts`, `state-vocabulary.ts` — is held to a STRICTER
 * rule than the rest of foundation: `node:` builtins and relative paths, nothing else.
 *
 * That is the machine form of what the user actually approved: state may live in foundation "as long
 * as it depends only on language/system builtins". Foundation's own guard is a DENYLIST — it rejects
 * `~/` and the sibling packages, and deliberately admits any bare npm package, because existing
 * foundation files legitimately use `consola` and `diff`. Reusing it here would have looked like
 * enforcement while permitting `import lodash from "lodash"` inside `state.ts`.
 *
 * When mutating this to check it still bites, use BOTH samples below. A `~/` import is caught by the
 * OLD denylist too, so on that sample alone the new criterion is indistinguishable from the old one
 * and "it went red" proves nothing. The bare-package sample is the one that only this rule rejects.
 */
const STATE_UNIT_ENTRIES = ["state.ts", "state-defaults.ts", "state-vocabulary.ts"]
const FOUNDATION_SRC = path.join(repoRoot, "packages/foundation/src")

/**
 * The project's own compiler options, so this guard resolves specifiers with EXACTLY the semantics
 * `tsc` uses. Read once — resolution happens per edge of the closure.
 *
 * `convertCompilerOptionsFromJson`, not `parseJsonConfigFileContent`: the latter also expands the
 * `include` globs (1208 files, ~380ms measured here) and this guard runs inside the 16-way sharded
 * unit tier, where that is most of the default 5s budget. The root tsconfig has no `extends`, so
 * converting its `compilerOptions` block loses nothing.
 */
const compilerOptions = ((): ts.CompilerOptions => {
  const configPath = path.join(repoRoot, "tsconfig.json")
  const raw = ts.readConfigFile(configPath, ts.sys.readFile)
  const converted = ts.convertCompilerOptionsFromJson((raw.config as { compilerOptions?: unknown }).compilerOptions, repoRoot, configPath)
  if (converted.errors.length > 0) throw new Error(`tsconfig.json compilerOptions failed to parse: ${converted.errors.map((e) => e.messageText).join("; ")}`)
  return converted.options
})()

/**
 * Resolve a specifier to a CANONICAL (symlink-free) absolute path, or `undefined`.
 *
 * Two deliberate choices, each replacing a hand-rolled version that looked equivalent and was not:
 *
 *  - **TypeScript's resolver, not a candidate table.** The previous `[base, base + ".ts",
 *    base + "/index.ts"]` rejected `./x.js`, which under `moduleResolution: "Bundler"` legally
 *    resolves to `x.ts` (the Node-ESM habit) and type-checks fine — so the guard failed on CORRECT
 *    code, the more expensive direction of wrong. `.tsx`/`.mts`/`.cts` were missing for the same
 *    reason, and extending the table would only have moved the next gap. Sharing `tsc`'s resolver
 *    means the guard cannot disagree with the compiler about what a specifier denotes.
 *  - **`realpathSync`, so containment is about the FILE, not the spelling.** A symlink under
 *    `packages/foundation/src` pointing at a core file has a lexical path inside the package and an
 *    identity outside it; comparing spellings would call that clean. Canonical paths also make
 *    `seen` terminate a symlinked directory cycle, instead of walking an ever-growing path until
 *    the filesystem errors out.
 */
function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  const resolved = ts.resolveModuleName(specifier, fromFile, compilerOptions, ts.sys).resolvedModule?.resolvedFileName
  return resolved === undefined ? undefined : realpathSync(resolved)
}

/** Is `target` (already canonical) inside `root`? `root` is canonicalised here for the same reason. */
function containedIn(root: string, target: string): boolean {
  const relative = path.relative(realpathSync(root), target)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/**
 * Walk the state unit's TRANSITIVE relative closure and report every specifier that is neither a
 * `node:` builtin nor a relative path resolving to a file INSIDE `packages/foundation/src`.
 *
 * Both halves are load-bearing, and the first version of this guard had neither — it checked the
 * three entry files' own specifiers and treated any string starting with `.` as internal:
 *
 *  - **transitive**: `state.ts` imports `./ghc-model-types`, which was not in the checked set, so a
 *    bare `consola` import added THERE passed every state guard. The property being claimed is about
 *    what state DEPENDS ON, and that is a closure, not three files.
 *  - **containment**: `../../../src/lib/models/model-name` is a relative path that lands back in
 *    core. It compiles, needs no alias, and re-establishes exactly the `foundation → core` edge this
 *    migration removed. "Starts with a dot" was never the same claim as "stays inside the package".
 *
 * Both were found by an independent reviewer mutating the tree, not by reasoning about the guard.
 */
async function stateUnitClosureViolations(): Promise<Array<string>> {
  const violations: Array<string> = []
  const seen = new Set<string>()
  const queue = STATE_UNIT_ENTRIES.map((name) => path.join(FOUNDATION_SRC, name))

  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)

    const sourceFile = parseSource(file, await readFile(file, "utf8"))
    for (const specifier of new Set(allModuleSpecifiers(sourceFile))) {
      if (specifier.startsWith("node:")) continue
      const relativeTo = path.relative(repoRoot, file)
      if (!specifier.startsWith(".")) {
        violations.push(`${relativeTo} → ${specifier} (not a node: builtin)`)
        continue
      }
      const resolved = resolveSpecifier(file, specifier)
      if (resolved === undefined) {
        violations.push(`${relativeTo} → ${specifier} (unresolvable)`)
        continue
      }
      if (!containedIn(FOUNDATION_SRC, resolved)) {
        violations.push(`${relativeTo} → ${specifier} (relative path ESCAPES the package, resolves to ${path.relative(repoRoot, resolved)})`)
        continue
      }
      queue.push(resolved)
    }
  }
  return violations.sort()
}

/** Single-specifier form, kept for the sample-based tests below. */
function stateUnitForbiddenSpecifiers(source: string, fileName = "state.ts"): Array<string> {
  return allModuleSpecifiers(parseSource(fileName, source)).filter(
    (specifier) => !specifier.startsWith("node:") && !specifier.startsWith("./") && !specifier.startsWith("../"),
  )
}

describe("state unit: only language/system builtins", () => {
  test("整个相对依赖闭包只 import node: 与 foundation 包内相对路径", async () => {
    expect(
      await stateUnitClosureViolations(),
      "state 单元的立身之本就是「只依赖语言/系统内置」。注意判据是**闭包**且**解析后**的位置——只查三个入口文件的直接 specifier，或把「以点开头」当成「包内」，都是更弱的另一个命题。",
    ).toEqual([])
  })

  test("闭包确实包含被传递依赖的文件（否则「零违规」只说明扫描没走到）", async () => {
    // `state.ts` → `./ghc-model-types`。第一版守卫漏的正是这个节点，而它零违规地绿着。
    const probe = path.join(FOUNDATION_SRC, "ghc-model-types.ts")
    expect(await Bun.file(probe).exists(), "闭包正控的目标文件不存在了，先修本测试再谈通过").toBe(true)
    const sourceFile = parseSource(path.join(FOUNDATION_SRC, "state.ts"), await readFile(path.join(FOUNDATION_SRC, "state.ts"), "utf8"))
    expect(allModuleSpecifiers(sourceFile)).toContain("./ghc-model-types")
  })

  test("判据比 foundation 的 denylist 更严：两个正样本，其中一个只有新判据咬得住", () => {
    // 样本 ①：`~/` —— 新旧判据都咬。**单用它做变异实验会得到假信号。**
    expect(stateUnitForbiddenSpecifiers('import { x } from "~/lib/error"')).toEqual(["~/lib/error"])
    expect(foundationHasForbiddenImport('import { x } from "~/lib/error"')).toBe(true)

    // 样本 ②：裸 npm 包 —— **只有新判据咬**。这条才证明新判据真的更严。
    expect(stateUnitForbiddenSpecifiers('import x from "lodash"')).toEqual(["lodash"])
    expect(foundationHasForbiddenImport('import x from "lodash"'), "foundation 的 denylist 放行任意裸包——这正是 state 单元需要单独一条 allowlist 的原因").toBe(
      false,
    )

    // 允许的形态一个都不能误伤。
    expect(stateUnitForbiddenSpecifiers('import { readFileSync } from "node:fs"')).toEqual([])
    expect(stateUnitForbiddenSpecifiers('import { x } from "./state-vocabulary"')).toEqual([])
  })

  test("覆盖全部 import 形态（side-effect / dynamic / import= / 内联 import 类型节点）", () => {
    expect(stateUnitForbiddenSpecifiers('import "~/lib/error"')).toEqual(["~/lib/error"])
    expect(stateUnitForbiddenSpecifiers('const x = await import("lodash")')).toEqual(["lodash"])
    expect(stateUnitForbiddenSpecifiers('import x = require("lodash")')).toEqual(["lodash"])
    expect(stateUnitForbiddenSpecifiers('type T = import("~/lib/error").HTTPError')).toEqual(["~/lib/error"])
  })

  // 解析器的两条自证。它们针对的是**守卫自身**可能出的两种错，方向相反：
  //   ① 对合法代码假红（`.js` specifier）—— 手写候选表犯的就是这个，且不会有人来救：架构测试红了，
  //      正常反应是改代码去迁就守卫，而不是怀疑守卫。
  //   ② 对越界代码假绿（symlink 实体在包外）—— 词法比较看不见，而这是守卫存在的全部理由。
  test("解析器与 tsc 同构：`.js` specifier 在 Bundler 模式下解析到 `.ts`，不算 unresolvable", () => {
    const stateTs = path.join(FOUNDATION_SRC, "state.ts")
    const expected = realpathSync(path.join(FOUNDATION_SRC, "state-defaults.ts"))
    expect(resolveSpecifier(stateTs, "./state-defaults"), "无扩展名形态").toBe(expected)
    expect(resolveSpecifier(stateTs, "./state-defaults.js"), "`./x.js` → `x.ts` 是 moduleResolution: Bundler 的合法写法，typecheck 通过，守卫就不能报 unresolvable").toBe(
      expected,
    )
    expect(resolveSpecifier(stateTs, "./does-not-exist")).toBeUndefined()
  })

  test("containment 判断实体而非拼写：指向包外的 symlink 必须算越界", () => {
    // 在临时目录里造真 symlink，不动被测仓库。
    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "state-containment-")))
    const inside = path.join(tmp, "pkg/src")
    mkdirSync(inside, { recursive: true })
    mkdirSync(path.join(tmp, "outside"), { recursive: true })
    writeFileSync(path.join(tmp, "outside/core.ts"), "export const x = 1\n")
    writeFileSync(path.join(inside, "sibling.ts"), "export const y = 1\n")
    writeFileSync(path.join(inside, "entry.ts"), 'export * from "./link"\nexport * from "./sibling"\n')
    symlinkSync(path.join(tmp, "outside/core.ts"), path.join(inside, "link.ts"))

    const entry = path.join(inside, "entry.ts")
    const viaSymlink = resolveSpecifier(entry, "./link")
    expect(viaSymlink, "symlink 的词法路径在包内，实体在包外——canonical 化后必须现形").toBe(path.join(tmp, "outside/core.ts"))
    expect(containedIn(inside, viaSymlink!)).toBe(false)
    // 正控：同一个判据对真正的包内文件必须放行，否则「红了」只说明它对一切都红。
    expect(containedIn(inside, resolveSpecifier(entry, "./sibling")!)).toBe(true)
  })
})

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
