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
import {
  //
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  allModuleSpecifiers,
  mayContainDecoded,
  moduleLoadSites,
  parseSource,
} from "./source-ast"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")

/**
 * These two assertions parse all of `src/lib`. Alone that is ~1.3s; under the 16-way sharded tier it
 * measured 4.0–4.5s against a 5s default, i.e. a slower machine turns an architecture guard into an
 * intermittent red that says nothing about architecture. The budget is explicit so the failure mode
 * is "the guard is slow" rather than "the guard is flaky" — and so nobody is tempted to buy the time
 * back with a substring pre-filter, which is what was wrong here twice.
 */
const SCAN_TIMEOUT_MS = 30_000

/**
 * The surviving inverted edges, newest information first. Removing one is the POINT — delete its row
 * when phase 1 lands it. Adding one is a regression; break the dependency instead, usually by
 * inverting it (the routes side passes the value down) rather than by widening this list.
 */
const KNOWN_CORE_TO_SERVER: Array<{ file: string; specifier: string }> = [
  { file: "src/lib/codec/openai-responses/codec.ts", specifier: "~/routes/responses/conversation-rebuild" },
  { file: "src/lib/pipeline/router.ts", specifier: "~/routes/responses/fallback" },
]

/**
 * Calls under `src/lib/**` whose module target is computed at runtime. Frozen for the same reason as
 * the edge list, and it is the other half of the same claim: a computed target could BE a `~/routes`
 * import, so a ratchet counting only static specifiers would report "no new edge" about code it
 * never actually read.
 *
 * `moduleLoadSites` over-approximates the CALLEE on purpose (see there), so this list also carries
 * calls that load nothing — that is the price of not maintaining a binder, and it is paid once per
 * row rather than forever. Adding a row is a deliberate act: say why the target cannot be a routes
 * module.
 */
const KNOWN_OPAQUE_TARGETS: Array<{ file: string; call: string }> = [
  // Mints a loader; loads nothing by itself.
  { file: "src/lib/history/search-native.ts", call: "createRequire(import.meta.url)" },
  // Probes for the optional native search binary, by absolute path — never a source module.
  { file: "src/lib/history/search-native.ts", call: "require(candidate)" },
  { file: "src/lib/history/search-native.ts", call: "require.resolve(candidate)" },
  // The user-configured hook module, resolved under `process.cwd()`.
  { file: "src/lib/pipeline/hooks/loader.ts", call: "import(join(process.cwd(), compiledPath))" },
  // Mints a loader; loads nothing by itself.
  { file: "src/lib/restart/notify.ts", call: "createRequire(import.meta.url)" },
]

/**
 * One pass over `src/lib`, answering both halves of the same claim.
 *
 * Parsing every file unconditionally, with no substring pre-filter, is deliberate. The obvious
 * filter (require `~/routes` / `import(` / `require(` to appear in the raw text) is wrong for each
 * half in a different way: escapes decode, `import /* c *\/ (target)` is a legal call whose text
 * contains no `import(`, and a `createRequire`-minted loader is called through a name no substring
 * scan can know in advance. One parse of all of `src/lib` is ~585ms measured — affordable, and
 * cheaper than the two filtered passes this replaces, which parsed some files twice.
 */
/** Every module extension `tsc` compiles. `.ts`-only was the bug: see `SOURCE_GLOB`'s own test. */
const SOURCE_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"

async function scanCoreLib(root = path.join(REPO_ROOT, "src/lib"), prefix = "src/lib"): Promise<{
  edges: Array<{ file: string; specifier: string }>
  opaque: Array<{ file: string; call: string }>
}> {
  const edges: Array<{ file: string; specifier: string }> = []
  const opaque: Array<{ file: string; call: string }> = []

  for await (const rel of new Glob(SOURCE_GLOB).scan({ cwd: root, onlyFiles: true })) {
    const file = `${prefix}/${rel}`
    const sourceFile = parseSource(file, readFileSync(path.join(root, rel), "utf8"))

    for (const specifier of new Set(allModuleSpecifiers(sourceFile))) {
      if (specifier === "~/routes" || specifier.startsWith("~/routes/")) edges.push({ file, specifier })
    }
    // Only sites whose TARGET is computed matter here: a literal `import("yaml")` is already an
    // edge the specifier scan above sees. `moduleLoadSites` over-approximates the CALLEE, so this
    // list also carries benign entries (a `createRequire(url)` that only mints a loader, a
    // `require.resolve`) — each registered once with a note, which is the price of not maintaining
    // a binder that keeps disagreeing with the real one.
    for (const site of moduleLoadSites(sourceFile)) {
      if (site.specifier === undefined) opaque.push({ file, call: site.text })
    }
  }

  edges.sort((a, b) => (a.file + a.specifier).localeCompare(b.file + b.specifier))
  opaque.sort((a, b) => (a.file + a.call).localeCompare(b.file + b.call))
  return { edges, opaque }
}

/** Both assertions read the same scan — running it twice doubled this file's cost for nothing. */
let scanned: ReturnType<typeof scanCoreLib> | undefined
const coreLib = (): ReturnType<typeof scanCoreLib> => (scanned ??= scanCoreLib())

describe("core → server 边 ratchet", () => {
  test("src/lib 通往 ~/routes 的边与登记表逐条相等（只许减少）", async () => {
    const expected = [...KNOWN_CORE_TO_SERVER].sort((a, b) => (a.file + a.specifier).localeCompare(b.file + b.specifier))
    expect(
      (await coreLib()).edges,
      "多出来的边 = core 又依赖了 HTTP 层，spec §7.2 阶段 1 正在专门消除这类边；\n" + "少掉的边 = 阶段 1 落地了一条，把对应行删掉。",
    ).toEqual(expected)
  }, SCAN_TIMEOUT_MS)

  test("守卫有效性：植入一条合成边会被抓到（否则「零新增」只证明了扫描没跑到）", () => {
    const planted = parseSource("synthetic.ts", 'import {\n  //\n  a,\n} from "~/routes/responses/ws"\n')
    const specifiers = allModuleSpecifiers(planted).filter((specifier) => specifier.startsWith("~/routes"))
    expect(specifiers).toEqual(["~/routes/responses/ws"])
  })

  test("模板字面量形态的动态 import 同样算一条边（它曾经能从这个 ratchet 底下走过去）", () => {
    const planted = parseSource("synthetic.ts", "const m = await import(`~/routes/responses/fallback`)\n")
    expect(allModuleSpecifiers(planted).filter((specifier) => specifier.startsWith("~/routes"))).toEqual(["~/routes/responses/fallback"])
  })

  test("src/lib 里静态不可判定的动态目标与登记表逐条相等", async () => {
    const expected = [...KNOWN_OPAQUE_TARGETS].sort((a, b) => (a.file + a.call).localeCompare(b.file + b.call))
    expect(
      (await coreLib()).opaque,
      "多出来的项 = 有一处 import()/require() 的目标是运行时算出来的，静态判据读不到它，\n" +
        "所以「没有新增 ~/routes 边」这句话对那个文件并不成立。确认它不可能指向 routes 层后登记，\n" +
        "或者把目标改成静态 specifier。",
    ).toEqual(expected)
  }, SCAN_TIMEOUT_MS)

  test("守卫有效性：合成的不可判定目标会被抓到", () => {
    // 报的是 CallExpression 本身，不含外层 `await`——登记表里的项也按这个形状写。
    const computed = (source: string): Array<string> =>
      moduleLoadSites(parseSource("synthetic.ts", source))
        .filter((site) => site.specifier === undefined)
        .map((site) => site.text)

    expect(computed("const p = 'x'\nconst m = await import(`~/${p}`)\n")).toEqual(["import(`~/${p}`)"])
    expect(computed("const m = require(someVar)\n")).toEqual(["require(someVar)"])
    // token 之间插注释是合法调用，且原始文本里根本没有 `import(`——曾经的子串预过滤会直接跳过整个文件。
    expect(computed("const m = import /* c */ (target)\n")).toHaveLength(1)
    // 反向：静态 specifier 不算不可判定，否则登记表会被真实边淹没。
    expect(computed('const m = await import("~/routes/x")\n')).toEqual([])
    expect(computed("const m = await import(`~/routes/x`)\n")).toEqual([])
  })

  // 扫描面的持久 oracle。**没有这条，把 glob 改回 `.ts` 全套件依旧全绿**（第七轮评审实测），
  // 于是「守卫覆盖 .mts」这件事只活在某次手工探针的记忆里。这里用临时目录喂真实文件给真实扫描函数。
  test("扫描面覆盖 tsc 能编译的每种扩展名，而不只是 .ts", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "core-scan-ext-"))
    try {
      const extensions = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]
      for (const extension of extensions) {
        await writeFile(path.join(fixture, `probe-${extension}.${extension}`), `import { a } from "~/routes/probe-${extension}"\nexport const x = a\n`)
      }
      await writeFile(path.join(fixture, "ignored.txt"), 'import { a } from "~/routes/nope"\n')

      const { edges } = await scanCoreLib(fixture, "fixture")
      expect(
        edges.map((edge) => edge.specifier).sort(),
        "每一种扩展名都必须被打开——`.mts` 是一等 TypeScript 模块，`.ts` 用 `./x.mjs` 就能引到它",
      ).toEqual(extensions.map((extension) => `~/routes/probe-${extension}`).sort())
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
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
