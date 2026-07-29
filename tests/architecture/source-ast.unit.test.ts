/**
 * `mayContainDecoded` 的自有 oracle。
 *
 * 它是几个「全树 AST 走查」守卫的预过滤：判 false 的文件**根本不会被解析**，所以它一旦漏报，
 * 上层守卫在那条路径上就是瞎的——而且是静默地瞎，测试照样全绿。它前两版都漏报过，且两版都
 * 自带一句「这不可能漏」的注释，所以这里把语言层面的转义形态逐个钉死，而不是钉当时想到的那几种。
 *
 * 判据方向也要钉：它是**保守**过滤器，允许假阳（多解析几个文件，只损耗性能）、绝不允许假阴。
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import ts from "typescript"

import {
  //
  allModuleSpecifiers,
  importedModuleSpecifiers,
  mayContainDecoded,
  moduleCapabilityAcquisitions,
  moduleLoadSites,
  referencedFilePaths,
  parseSource,
} from "./source-ast"

/**
 * 编译器对一段源码报出的诊断码。用于断言「某个写法在语法上不合法」这类**关于语言本身**的命题——
 * 这种命题用「我们的收集器返回 []」是自证不了的，收集器不认它的时候返回的也是 []。
 *
 * `noLib` + `noResolve`：这里只关心语法/文法诊断，模块解析与 lib 缺失产生的噪声码一概不看。
 * 单个程序约 11ms。
 */
function grammarErrorCodes(source: string): Array<string> {
  const fileName = "/virtual/probe.ts"
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/virtual",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? source : undefined),
  }
  const program = ts.createProgram([fileName], { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext }, host)
  return [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)].map((diagnostic) => `TS${diagnostic.code}`)
}

/** 每一项：原始文本里都**没有** `~/routes`，但解析后确实是那条 import。 */
const DECODED_ONLY: Array<[string, string]> = [
  ["hex escape", 'import "\\x7e/routes/x"\n'],
  ["unicode escape", 'import "\\u007e/routes/x"\n'],
  ["unicode code point escape", 'import "\\u{7e}/routes/x"\n'],
  ["identity escape（`\\e` → `e`，`/\\\\[ux]/` 版就漏在这）", 'import "~/rout\\es/x"\n'],
  ["line continuation（反斜杠+换行把 needle 劈成两行）", 'import "~/rou\\\ntes/x"\n'],
]

describe("mayContainDecoded", () => {
  test.each(DECODED_ONLY)("放行只在解码后才出现的拼法：%s", (_name, source) => {
    // 三段都要断言，否则「返回 true」可能只是因为样本根本没有转义。
    expect(source.includes("~/routes"), "前提：原始文本确实不含目标子串").toBe(false)
    expect(allModuleSpecifiers(parseSource("p.ts", source)), "前提：这确实是一条通往目标的边").toEqual(["~/routes/x"])
    expect(mayContainDecoded(source, "~/routes")).toBe(true)
  })

  test("原始文本直接含有目标：放行（最便宜的一档）", () => {
    expect(mayContainDecoded('import "~/routes/x"\n', "~/routes")).toBe(true)
  })

  test("不含反斜杠就一定不含解码差异：挡下（这一档没了预过滤就没有意义）", () => {
    expect(mayContainDecoded("import { a } from './b'\nconst s = 'plain text'\n", "~/routes")).toBe(false)
  })

  test("有反斜杠但解码后仍无目标：挡下（否则退化成「见反斜杠就解析」，实测慢 5 倍）", () => {
    expect(mayContainDecoded('const re = /\\d+/\nconst s = "a\\tb"\n', "~/routes")).toBe(false)
  })

  test("模板字面量与标识符里的转义同样看得见", () => {
    expect(mayContainDecoded("const s = `\\x7e/routes/x`\n", "~/routes")).toBe(true)
    expect(mayContainDecoded("const a = SEPARATOR_CARRI\\u0045RS\n", "SEPARATOR_CARRIERS")).toBe(true)
  })

  test("注释里的目标也放行——这一层不做语义判断，语义归调用方的 AST 判据", () => {
    // 预过滤只负责「不漏」，把注释与真引用区分开是 AST 那一步的事。这里明确写出来，免得后来者
    // 把「注释误报」当成本函数的 bug 去收紧它，从而制造漏报。
    expect(mayContainDecoded("// 这句话提到了 ~/routes\n", "~/routes")).toBe(true)
  })
})

/**
 * 动态 `import()` / `require()` 的实参是**表达式**，所以模板字面量在那里合法（tsc 实测通过），
 * 而 import/export 声明位要求语法层的 StringLiteral、写模板会得到 TS1141。
 * 建立在 `allModuleSpecifiers` 上的守卫全都因此漏过 ``import(`consola`)``——state 单元看着没有裸包、
 * core→server ratchet 看着没新增边。这一组把两侧都钉死：合法的要报，报不出来的不许假装报得出。
 */
describe("allModuleSpecifiers：模板字面量形态", () => {
  test.each([
    ["dynamic import", "const m = await import(`consola`)\n"],
    ["require", "const m = require(`consola`)\n"],
  ])("%s 的模板实参照样算一条边（tsc 认它，守卫就必须认）", (_name, source) => {
    expect(allModuleSpecifiers(parseSource("p.ts", source))).toEqual(["consola"])
  })

  test("带插值的模板不报（没有静态 specifier 可报，编造一个是撒谎而不是补洞）", () => {
    expect(allModuleSpecifiers(parseSource("p.ts", "const n = 'x'\nconst m = await import(`~/${n}`)\n"))).toEqual([])
  })

  test("import()/require() 之外的位置写模板是 TS1141——所以那些位置故意只认 StringLiteral", () => {
    // 这条守的是 `allModuleSpecifiers` 注释里那句论证。**光断言「返回 []」是自证不了它的**：
    // 语法真放开了，`isStringLiteral` 版照样返回 []，测试照样绿。所以这里真的去问编译器要诊断。
    for (const source of ["import m from `consola`\n", "export * from `consola`\n", "import m = require(`consola`)\n", "type T = import(`consola`).X\n"]) {
      expect(grammarErrorCodes(source), `${source.trim()} 应当是 TS1141；若它某天合法了，就该去放宽判据`).toContain("TS1141")
      expect(allModuleSpecifiers(parseSource("p.ts", source)), "既然不合法，收集器就不该假装能收到它").toEqual([])
    }
    // 正控：唯一合法的那两个位置**没有** TS1141，否则上面的断言只是「什么都报 TS1141」。
    expect(grammarErrorCodes("const m = import(`consola`)\n")).not.toContain("TS1141")
    expect(grammarErrorCodes("const m = require(`consola`)\n")).not.toContain("TS1141")
  })
})

/**
 * `importedModuleSpecifiers` 与 `allModuleSpecifiers` 是两份独立实现（前者只要运行时边、排除
 * type-only），所以模板字面量那个洞在两边各有一份，**必须各自有测试**——只测其中一个的话，
 * 把另一个退回 `isStringLiteral` 全套件依旧全绿（第四轮评审实测如此）。
 */
describe("importedModuleSpecifiers", () => {
  test("动态 import / require 的模板实参照样算一条运行时边", () => {
    expect(importedModuleSpecifiers(parseSource("p.ts", "const m = await import(`consola`)\n"))).toEqual(["consola"])
    expect(importedModuleSpecifiers(parseSource("p.ts", "const m = require(`consola`)\n"))).toEqual(["consola"])
  })

  test("仍然排除 type-only import（它没有运行时边）", () => {
    expect(importedModuleSpecifiers(parseSource("p.ts", 'import type { X } from "consola"\n'))).toEqual([])
    expect(importedModuleSpecifiers(parseSource("p.ts", 'import { X } from "consola"\n'))).toEqual(["consola"])
  })
})

/**
 * `moduleLoadSites` 是**故意的过近似**：callee 侧只问「这看起来像不像一次加载」，不做作用域解析。
 *
 * 四轮评审的记录就是它的存在理由——只认字面 `require` 漏掉 `createRequire`；按文件跟踪 `createRequire`
 * 绑定被嵌套形参一关就全瞎；改成沿 parent 链做词法解析，仍然把 `var` 的提升搞错，而且
 * `createRequire(url)("consola")` 这种 callee 本身是调用的形态照样漏。**每一次都补上了被演示的那个形态，
 * 下一次探针又找到新的。** 所以判据从「是不是 loader」换成「可不可能是」——一个不依赖作用域、提升、
 * callee 形状的问题。
 *
 * 代价是假阳（`require.resolve`、只是铸造 loader 的 `createRequire(url)`、恰好叫 require 的局部函数），
 * 这是**该错的方向**。实参侧仍然精确：字面量报边，其余报「不可判定」。
 */
describe("moduleLoadSites", () => {
  const texts = (source: string): Array<string> => moduleLoadSites(parseSource("p.ts", source)).map((site) => site.text)
  const specifiers = (source: string): Array<string | undefined> => moduleLoadSites(parseSource("p.ts", source)).map((site) => site.specifier)

  test.each([
    ["动态 import 字面量", 'const m = await import("consola")\n', "consola"],
    ["无插值模板", "const m = await import(`consola`)\n", "consola"],
    ["ambient require", 'const m = require("consola")\n', "consola"],
    ["createRequire 铸造后**直接调用**（callee 本身是一次调用）", 'import { createRequire } from "node:module"\nvoid createRequire(import.meta.url)("consola")\n', "consola"],
    ["import.meta.require", 'void import.meta.require("consola")\n', "consola"],
    ["先绑定再调用", 'import { createRequire } from "node:module"\nconst load = createRequire(import.meta.url)\nvoid load("consola")\n', "consola"],
    ["动态 import 解构出的 createRequire", 'const { createRequire } = await import("node:module")\nconst load = createRequire(import.meta.url)\nvoid load("consola")\n', "consola"],
    ["var 提升出 block（自写 binder 曾在这里判错）", 'import { createRequire } from "node:module"\n{\n  var load = createRequire(import.meta.url)\n}\nvoid load("consola")\n', "consola"],
  ])("%s：目标是字面量就报出来", (_name, source, expected) => {
    expect(specifiers(source)).toContain(expected)
  })

  test.each([
    ["模板插值", "const p = 'x'\nconst m = await import(`~/${p}`)\n"],
    ["标识符实参", "const m = require(someVar)\n"],
    ["token 之间插注释", "const m = import /* c */ (target)\n"],
  ])("%s：目标算不可判定", (_name, source) => {
    expect(specifiers(source)).toEqual([undefined])
  })

  test("普通调用不算（否则登记表会被整个代码库淹没）", () => {
    expect(texts('doSomething("x")\nrequireAuth(user)\nconst n = myRequirements.length\n')).toEqual([])
  })

  test("过近似的方向是已知且刻意的：这些确实会被报出来", () => {
    // 写在测试里而不是只写在注释里——它是判据的一部分，不是缺陷。
    expect(texts("const r = require.resolve(x)\n")).toEqual(["require.resolve(x)"])
    expect(texts('import { createRequire } from "node:module"\nconst load = createRequire(import.meta.url)\n')).toEqual(["createRequire(import.meta.url)"])
  })
})

describe("referencedFilePaths", () => {
  test("triple-slash reference 是一条没有 specifier 的依赖边，同样要报", () => {
    const source = '/// <reference path="../../../outside.d.ts" />\nexport const x = 1\n'
    expect(referencedFilePaths(parseSource("p.ts", source))).toEqual(["../../../outside.d.ts"])
    // 它在任何基于 import 的检查里都是隐形的——这正是它必须单独有一条的原因。
    expect(allModuleSpecifiers(parseSource("p.ts", source))).toEqual([])
  })

  test("没有 reference 的文件返回空", () => {
    expect(referencedFilePaths(parseSource("p.ts", 'import { a } from "./b"\n'))).toEqual([])
  })
})

/**
 * 「按名字追 loader」这条路走到头了，这一组就是它的墓志铭。
 *
 * 最后一版已经把**调用**过近似了，可 loader 名字的种子仍然来自「初始化表达式文本里提到 createRequire」，
 * 于是 `import { createRequire as mint }`（改名导入）和 `const mint = createRequire`（工厂别名）
 * 照样穿过去——**一个披着过近似外衣的欠近似**，而且我自己没看出来，是评审指出的。
 *
 * 别名是无界的，但**能力**只从很少几扇门进来：import `node:module`（`createRequire` 的唯一来源）、
 * 或 `process.getBuiltinModule`。没拿到的东西没法改名，所以守门不需要任何来源分析。
 */
describe("moduleCapabilityAcquisitions", () => {
  test.each([
    ["具名 import", 'import { createRequire } from "node:module"\n'],
    ["改名导入（按名字追那版漏的就是它）", 'import { createRequire as mint } from "node:module"\n'],
    ["namespace import", 'import * as m from "node:module"\n'],
    ["default import", 'import m from "node:module"\n'],
    ["无 node: 前缀", 'import { createRequire } from "module"\n'],
    ["side-effect import", 'import "node:module"\n'],
    ["re-export", 'export { createRequire } from "node:module"\n'],
    ["import = require", 'import m = require("node:module")\n'],
    ["动态 import", 'const m = await import("node:module")\n'],
    ["require", 'const m = require("node:module")\n'],
    ["process.getBuiltinModule", 'const m = process.getBuiltinModule("module")\n'],
  ])("%s 算一次能力获取", (_name, source) => {
    expect(moduleCapabilityAcquisitions(parseSource("p.ts", source))).toHaveLength(1)
  })

  test("普通模块不算（否则每个文件都会被报出来，登记表就没有意义了）", () => {
    expect(moduleCapabilityAcquisitions(parseSource("p.ts", 'import { a } from "consola"\nconst m = await import("./x")\n'))).toEqual([])
    // `node:module` 之外的 node: 内置也不算——能力的来源只有那一个模块。
    expect(moduleCapabilityAcquisitions(parseSource("p.ts", 'import { readFileSync } from "node:fs"\n'))).toEqual([])
  })

  test("能力判据独立于「按名字追 loader」是否追得到（这正是它存在的理由）", () => {
    const aliased = 'import { createRequire as mint } from "node:module"\nconst load = mint(import.meta.url)\nvoid load("consola")\n'
    const parsed = parseSource("p.ts", aliased)
    // 名字这条线确实追不到 `load("consola")`——记下来，免得以后有人以为它能。
    expect(moduleLoadSites(parsed).some((site) => site.specifier === "consola")).toBe(false)
    // 但能力那条线拦得住。
    expect(moduleCapabilityAcquisitions(parsed)).toHaveLength(1)
  })
})
