/**
 * The core → server edge ratchet: `src/lib/**` (the future core package) may only reach into
 * `src/routes/**` (the future server package) at the two places listed here, and that list may only
 * shrink.
 *
 * spec/2026-07-22-monorepo-workspace-split.md §7.2 phase 1 is specifically about eliminating these
 * last inverted edges — core must not depend on the HTTP layer that sits above it. Two survive
 * today. Freezing them stops a third from appearing while phase 1 is still pending, which is the
 * failure mode this guard exists for: the edges are easy to add by accident (the import looks like
 * any other) and expensive to remove later, because by then something depends on the coupling.
 *
 * It also enforces a placement constraint that has no other home. `src/lib/config/model-overrides.ts`
 * holds four per-vendor resolvers whose callers are mostly under `src/routes/**`, so "move it next
 * to its consumers" reads as the obvious refactor — and would be wrong, because `config.ts` (core)
 * consumes one of them too, which is exactly how a core → server edge gets born. This guard is what
 * catches that, and it is the only mechanical statement of the rule.
 */

import { Glob } from "bun"
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
  mayContainDecoded,
  parseSource,
} from "./source-ast"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")

/**
 * The surviving inverted edges, newest information first. Removing one is the POINT — delete its row
 * when phase 1 lands it. Adding one is a regression; break the dependency instead, usually by
 * inverting it (the routes side passes the value down) rather than by widening this list.
 */
const KNOWN_CORE_TO_SERVER: Array<{ file: string; specifier: string }> = [
  { file: "src/lib/codec/openai-responses/codec.ts", specifier: "~/routes/responses/conversation-rebuild" },
  { file: "src/lib/pipeline/router.ts", specifier: "~/routes/responses/fallback" },
]

async function coreFilesImportingServer(): Promise<Array<{ file: string; specifier: string }>> {
  const found: Array<{ file: string; specifier: string }> = []
  for await (const rel of new Glob("**/*.ts").scan({ cwd: path.join(REPO_ROOT, "src/lib"), onlyFiles: true })) {
    const file = `src/lib/${rel}`
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8")
    if (!mayContainDecoded(text, "~/routes")) continue
    const sourceFile = parseSource(file, text)
    for (const specifier of new Set(allModuleSpecifiers(sourceFile))) {
      if (specifier === "~/routes" || specifier.startsWith("~/routes/")) found.push({ file, specifier })
    }
  }
  return found.sort((a, b) => (a.file + a.specifier).localeCompare(b.file + b.specifier))
}

describe("core → server 边 ratchet", () => {
  test("src/lib 通往 ~/routes 的边与登记表逐条相等（只许减少）", async () => {
    const expected = [...KNOWN_CORE_TO_SERVER].sort((a, b) => (a.file + a.specifier).localeCompare(b.file + b.specifier))
    expect(
      await coreFilesImportingServer(),
      "多出来的边 = core 又依赖了 HTTP 层，spec §7.2 阶段 1 正在专门消除这类边；\n" + "少掉的边 = 阶段 1 落地了一条，把对应行删掉。",
    ).toEqual(expected)
  })

  test("守卫有效性：植入一条合成边会被抓到（否则「零新增」只证明了扫描没跑到）", () => {
    const planted = parseSource("synthetic.ts", 'import {\n  //\n  a,\n} from "~/routes/responses/ws"\n')
    const specifiers = allModuleSpecifiers(planted).filter((specifier) => specifier.startsWith("~/routes"))
    expect(specifiers).toEqual(["~/routes/responses/ws"])
  })

  test("预过滤对转义拼法也放行（原始文本里没有 `~/routes`，AST 解出来却有）", () => {
    // 三种拼法，解码后都是同一条边，原始文本都不含目标子串。后两种是 `/\\[ux]/` 版预过滤漏掉的——
    // 「产生任意字符必须用 hex/unicode 转义」是错的：`\e` 是 identity escape，反斜杠加换行是行接续。
    for (const [name, escaped] of [
      ["hex escape", 'import "\\x7e/routes/responses/ws"\n'],
      ["identity escape", 'import "~/rout\\es/responses/ws"\n'],
      ["line continuation", 'import "~/rou\\\ntes/responses/ws"\n'],
    ] as const) {
      expect(escaped.includes("~/routes"), `${name}：前提是原始文本确实不含目标子串`).toBe(false)
      expect(allModuleSpecifiers(parseSource("escaped.ts", escaped)), `${name}：AST 解码后就是那条边`).toEqual(["~/routes/responses/ws"])
      expect(mayContainDecoded(escaped, "~/routes"), `${name}：预过滤必须放它进 AST，否则守卫在这条路径上是瞎的`).toBe(true)
    }
    // 反向：不含反斜杠的普通文件仍被挡在 AST 之外，否则这条修复等于取消了预过滤。
    expect(mayContainDecoded("import { a } from './b'\n", "~/routes")).toBe(false)
  })
})
