/**
 * The state → foundation ratchet: `state.ts` and `state-defaults.ts` may only import what this file
 * says they may.
 *
 * These two modules are being reduced to a **leaf that depends on nothing but language/system
 * builtins**, so they can move into `packages/foundation` (docs/plan/2026-07-28-state-to-foundation/
 * HANDOVER.md). The migration removes their out-edges a few at a time, and the previous round's
 * biggest mistake was auditing those edges BY HAND: the hand-written list missed five edges, one of
 * which (`~/lib/token/types`) is a package-layering inversion that would have failed the final move
 * after five commits of work. So the list lives here, machine-checked, instead of in prose.
 *
 * **This is a ratchet, not a snapshot.** Adding an edge fails immediately. Removing one fails too —
 * deliberately: it forces whoever finished a step to come here, delete the row, and see what is
 * left. That is the entry criterion for the physical move: when both tables contain nothing but
 * `node:` and relative specifiers, `state` is a leaf and S6 can start.
 *
 * The enumeration goes through `allModuleSpecifiers()` (a real parse), NOT a regex. `rg '^import'`
 * silently misses every multi-line import in this repo — the `from` sits on the closing line — and
 * `rg 'from "'` misses side-effect imports, `import = require`, dynamic `import()` and the inline
 * `import("./x").T` type node that `state-defaults.ts` actually contains. Both mistakes were made
 * for real while writing the plan this guard replaces.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import {
  //
  allModuleSpecifiers,
  createSpecifierResolver,
  parseSource,
} from "./source-ast"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")
const resolveSpecifier = createSpecifierResolver(REPO_ROOT)

/**
 * An edge's IDENTITY — where it lands — rather than how it was spelled.
 *
 * Freezing the raw text makes this ratchet reject `./state-defaults.js`, which resolves to the very
 * file already on the list, type-checks, and passes the package closure guard. That is a false RED
 * on correct code, the expensive direction: the natural response to a red architecture test is to
 * change the code. It is the same "compare the target, not the spelling" lesson the closure guard
 * and the core ratchet each had to learn separately — this is the third consumer.
 */
const edgeIdentity = (fromFile: string, specifier: string): string => {
  const resolved = resolveSpecifier(path.join(REPO_ROOT, fromFile), specifier)
  return resolved === undefined ? specifier : path.relative(REPO_ROOT, resolved)
}

/**
 * Every remaining out-edge, with the step that removes it. Keep the reason column honest — a row
 * whose reason no longer matches the code is worse than no row at all.
 */
const ALLOWED: Record<string, Array<{ specifier: string; removedBy: string }>> = {
  "packages/foundation/src/state.ts": [
    { specifier: "./state-defaults", removedBy: "never — same unit, moves together" },
    { specifier: "./state-vocabulary", removedBy: "never — the zero-import vocabulary leaf, moves together" },
    {
      specifier: "./ghc-model-types",
      removedBy: "never — the GHC catalog wire types sank into foundation (user decision 2026-07-28); a package-internal sibling now",
    },
  ],
  "packages/foundation/src/state-defaults.ts": [{ specifier: "./state-vocabulary", removedBy: "never — the zero-import vocabulary leaf, moves together" }],
  "packages/foundation/src/state-vocabulary.ts": [],
}

const outEdges = (rel: string): Array<string> => {
  const sourceFile = parseSource(rel, readFileSync(path.join(REPO_ROOT, rel), "utf8"))
  return [...new Set(allModuleSpecifiers(sourceFile).map((specifier) => edgeIdentity(rel, specifier)))].sort()
}

describe("state → foundation：出边 ratchet", () => {
  test.each(Object.keys(ALLOWED))("%s 的出边集与登记表逐条相等", (rel) => {
    const expected = [...new Set(ALLOWED[rel].map((row) => edgeIdentity(rel, row.specifier)))].sort()
    expect(
      outEdges(rel),
      `出边集与 ${path.basename(import.meta.path)} 的登记表不符。\n`
        + `多出来的边 = 有人给正在叶子化的模块加了新依赖，先问这条边是否必要；\n`
        + `少掉的边 = 某一步做完了，把对应行删掉，然后看剩下什么。`,
    ).toEqual(expected)
  })

  test("每条登记的边都写明由哪一步消除（空理由等于没登记）", () => {
    const unexplained = Object.entries(ALLOWED).flatMap(([rel, rows]) =>
      rows.filter((row) => row.removedBy.trim().length < 20).map((row) => `${rel} → ${row.specifier}`),
    )
    expect(unexplained).toEqual([])
  })

  test("S2/S5 已完成：state 对 models 域零出边（wire 类型已下沉 foundation）", () => {
    // S2 把目录缓存搬去 `~/lib/models/cache`，带走了 `normalizeForMatching` 这条唯一的值出边；S5 把
    // `Model` / `ModelsResponse` 下沉进 foundation，`models/client.ts` 改为 re-export。判据从「只剩一条
    // 纯类型边」收紧成「零边」——问题变了，答案要跟着重算，别沿用上一步的形状。
    const sourceFile = parseSource("packages/foundation/src/state.ts", readFileSync(path.join(REPO_ROOT, "packages/foundation/src/state.ts"), "utf8"))
    const modelsEdges = [...new Set(allModuleSpecifiers(sourceFile))].filter((specifier) => specifier.includes("/models/"))
    expect(modelsEdges).toEqual([])
  })

  test("S6 已落地：三个文件只剩 node: 与相对路径", () => {
    // 这就是「只依赖语言/系统内置」的机器形态。S6 之前这条断言的可接受集里还含 foundation 包名（那时
    // 三个文件还在 src/，取 wire 类型只能走包名）；搬进 packages/foundation/src 之后它变成了同包相对
    // 路径，可接受集随之收紧——判据的形状要跟着事实走，而不是留着更宽的旧形状继续绿。
    // Stated over edge IDENTITY, like the rest of this file: a `node:` builtin, or a target that
    // resolves inside the package. "The specifier starts with a dot" was the weaker claim — a dot
    // path can still resolve out of the package, which is exactly what the closure guard exists for.
    const acceptable = (identity: string): boolean => identity.startsWith("node:") || identity.startsWith(`packages/foundation/src${path.sep}`)
    const blocking = Object.keys(ALLOWED).flatMap((rel) => outEdges(rel).filter((identity) => !acceptable(identity)))
    expect(blocking, `还有 ${blocking.length} 条出边挡着物理搬迁：\n${blocking.join("\n")}`).toEqual([])
  })
})
