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
  parseSource,
  typeOnlyModuleSpecifiers,
} from "./source-ast"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")

/**
 * Every remaining out-edge, with the step that removes it. Keep the reason column honest — a row
 * whose reason no longer matches the code is worse than no row at all.
 */
const ALLOWED: Record<string, Array<{ specifier: string; removedBy: string }>> = {
  "src/lib/state.ts": [
    {
      specifier: "./adaptive-rate-limiter",
      removedBy: "S5 — type-only (`AdaptiveRateLimiterConfig`); the relative path hides that this becomes a CROSS-PACKAGE edge once state moves",
    },
    {
      specifier: "./state-defaults",
      removedBy: "never — same unit, moves together (the two-node cycle between them is broken in S5 by `state-vocabulary.ts`)",
    },
    {
      specifier: "~/lib/anthropic/sanitize/assistant-block-layout",
      removedBy: "S5 — type-only (`AssistantBlockLayoutStrategy`, `SeparatorCarrier`), ownership inverts",
    },
    { specifier: "~/lib/anthropic/sanitize/content-blocks", removedBy: "S5 — type-only (`ThinkingBlockSanitizeMode`), ownership inverts" },
    {
      specifier: "~/lib/anthropic/tool-input-repair",
      removedBy:
        "S5 — type-only (`RepairItem`); it is `(typeof REPAIR_ITEMS)[number]`, so the const array must move too or become an explicit union + assignability assertion",
    },
    { specifier: "~/lib/config/schema", removedBy: "S5 — type-only (`ModelTranslation`), ownership inverts" },
    {
      specifier: "~/lib/models/client",
      removedBy:
        "S5 — type-only (`Model`, `ModelsResponse`); user decision 2026-07-28 sinks both into foundation next to `ghc-http-primitives`, `models/client.ts` re-exports",
    },
  ],
  "src/lib/state-defaults.ts": [
    {
      specifier: "./state",
      removedBy:
        'S5 — 11 named types + the inline `import("./state").MaxTokensContinuationOverride` on the `maxTokensContinuationOverrides` field all move to `state-vocabulary.ts`',
    },
    { specifier: "~/lib/anthropic/refusal-policy", removedBy: "S5 — VALUE edge, parked on a zero-import leaf by S1; the defaults come home to this file" },
    {
      specifier: "~/lib/anthropic/sanitize/block-layout-contract",
      removedBy: "S5 — type-only (`AssistantBlockLayoutStrategy`, `SeparatorCarrier`), ownership inverts",
    },
    { specifier: "~/lib/anthropic/sanitize/content-blocks", removedBy: "S5 — type-only (`ThinkingBlockSanitizeMode`), ownership inverts" },
    {
      specifier: "~/lib/anthropic/sanitize/separator-carrier",
      removedBy: "S5 — VALUE edge, parked on a zero-import leaf by S1; `DEFAULT_SEPARATOR_CARRIER` comes home to this file",
    },
    { specifier: "~/lib/anthropic/tool-input-repair", removedBy: "S5 — type-only (`RepairItem`), ownership inverts" },
    { specifier: "~/lib/config/schema", removedBy: "S5 — type-only (`ModelTranslation`), ownership inverts" },
  ],
}

const outEdges = (rel: string): Array<string> => {
  const sourceFile = parseSource(rel, readFileSync(path.join(REPO_ROOT, rel), "utf8"))
  return [...new Set(allModuleSpecifiers(sourceFile))].sort()
}

describe("state → foundation：出边 ratchet", () => {
  test.each(Object.keys(ALLOWED))("%s 的出边集与登记表逐条相等", (rel) => {
    const expected = ALLOWED[rel].map((row) => row.specifier).sort()
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

  test("S2 已完成：state 对 models 域只剩一条纯类型边", () => {
    // S2 把目录缓存（rawModels / setModels / getRawModels / getConfigDisabledIds /
    // resetRawModelsForTests）搬去 `~/lib/models/cache`，随之带走了 `normalizeForMatching` 这条唯一的
    // **值**出边。剩下的 `~/lib/models/client` 只提供 `Model` / `ModelsResponse` 两个类型，归 S5。
    //
    // 判据必须区分 type/value：`allModuleSpecifiers()` 两者都收，直接拿它断言「零 models 边」会红在一条
    // 本来就该留到 S5 的类型边上——把「S2 没做完」和「S5 还没开始」混成同一个信号。
    const source = readFileSync(path.join(REPO_ROOT, "src/lib/state.ts"), "utf8")
    const sourceFile = parseSource("src/lib/state.ts", source)
    const modelsEdges = [...new Set(allModuleSpecifiers(sourceFile))].filter((specifier) => specifier.includes("/models/"))
    const typeOnly = new Set(typeOnlyModuleSpecifiers(sourceFile))

    expect(modelsEdges).toEqual(["~/lib/models/client"])
    expect(
      modelsEdges.filter((specifier) => !typeOnly.has(specifier)),
      "state 又长回了一条通往 models 域的值依赖",
    ).toEqual([])
  })

  test("S6 的入口判据（现在应当仍未满足——满足了就该去做 S6 了）", () => {
    const isBuiltinOrRelative = (specifier: string): boolean => specifier.startsWith("node:") || specifier.startsWith(".")
    const remaining = Object.keys(ALLOWED).flatMap((rel) => outEdges(rel).filter((specifier) => !isBuiltinOrRelative(specifier)))
    // 这条断言的形态是「还剩几条」而不是「已经为空」：它让每一步的进度可见，而不是一路红到 S6。
    expect(remaining.length, `还剩 ${remaining.length} 条非内置/非相对出边：\n${remaining.join("\n")}`).toBeGreaterThan(0)
  })
})
