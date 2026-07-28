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

import {
  //
  allModuleSpecifiers,
  mayContainDecoded,
  parseSource,
} from "./source-ast"

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
