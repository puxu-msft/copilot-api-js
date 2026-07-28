/**
 * S1 守卫：`state-defaults.ts` 的**值**出边只许指向零依赖叶子。
 *
 * 背景（docs/plan/2026-07-28-state-to-foundation/HANDOVER.md §3.2 / §3.7 #11 #15）：把 `state.ts` +
 * `state-defaults.ts` 降成 foundation 叶子的第一步，是切断 `state-defaults` 通往 anthropic 域的两条
 * **值**依赖——三个 refusal 默认文案与 `DEFAULT_SEPARATOR_CARRIER`。这两条边把 state 拴进了 70 个环里的
 * 50 个：实测把它们挪进零依赖叶子后，madge 环数 70/63 成员 → 30/43。
 *
 * 为什么守卫要盯「目标叶子零出边」而不是「state-defaults 零值依赖」：S1 之后 `state-defaults` 仍然有值
 * 依赖（它要从叶子取那四个常量），削环靠的不是「没有值边」而是「值边的目标是叶子」——叶子没有出边，
 * 所以谁依赖它都不可能成环。把判据写成前者会既漏又误（HANDOVER 第一版的 S1 里程碑就写错成了「零值
 * 依赖」）。
 *
 * ⚠️ 本文件断言的是**当前的过渡态**，不是终态。S5 会把这两个叶子的内容吸收进 state 单元本身（类型→
 * `state-vocabulary`、默认值→`state-defaults` 自己声明），届时这些边会整条消失，本守卫要跟着改。
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

import {
  //
  DEFAULT_REFUSAL_END_TURN_TEXT,
  DEFAULT_REFUSAL_ERROR_MESSAGE,
  DEFAULT_REFUSAL_ERROR_TYPE,
} from "~/lib/anthropic/refusal-policy"
import {
  //
  DEFAULT_SEPARATOR_CARRIER,
  SEPARATOR_CARRIERS,
  separatorText,
} from "~/lib/anthropic/sanitize/separator-carrier"

import {
  //
  allModuleSpecifiers,
  parseSource,
} from "./source-ast"

const REPO_ROOT = path.resolve(import.meta.dir, "../..")

const parse = (rel: string): ts.SourceFile => parseSource(rel, readFileSync(path.join(REPO_ROOT, rel), "utf8"))

/**
 * 名字在**本文件里被声明**（而不是从别处 re-export）。
 *
 * 这是「单一 owner」的正确判据。值相等不是：四个常量都是 primitive string，`toBe` 与 `toEqual` 对字符串
 * 都只是值相等，两处各写一份一模一样的字面量照样通过（HANDOVER §6 第 8 条记着这个证伪）。
 */
function locallyDeclaredNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
      }
      continue
    }
    if (
      (ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isEnumDeclaration(statement)
        || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement))
      && statement.name
    ) {
      names.add(statement.name.text)
    }
  }
  return names
}

/** 这个模块 import/re-export 了哪些模块（AST 口径，覆盖多行 / side-effect / dynamic / `import =` 全形态）。 */
const outEdges = (rel: string): Array<string> => [...new Set(allModuleSpecifiers(parse(rel)))].sort()

const MOVED_TO_REFUSAL_POLICY = ["DEFAULT_REFUSAL_END_TURN_TEXT", "DEFAULT_REFUSAL_ERROR_MESSAGE", "DEFAULT_REFUSAL_ERROR_TYPE"]
const MOVED_TO_SEPARATOR_CARRIER = ["SYNTHETIC_SEPARATOR_PREFIX", "SEPARATOR_CARRIERS", "SeparatorCarrier", "DEFAULT_SEPARATOR_CARRIER", "separatorText"]

describe("S1 — state-defaults 的值依赖只指向零依赖叶子", () => {
  // ── 承重判据：叶子必须真的是叶子 ────────────────────────────────────────────────
  test.each(["src/lib/anthropic/refusal-policy.ts", "src/lib/anthropic/sanitize/separator-carrier.ts"])("%s 零出边（叶子身份就是它的全部价值）", (leaf) => {
    expect(outEdges(leaf), `${leaf} 一旦有出边就不再是叶子，state-defaults 依赖它就会重新成环`).toEqual([])
  })

  test("state-defaults 的每一条值出边都落在上面那两个叶子上", () => {
    const sourceFile = parse("src/lib/state-defaults.ts")
    const valueEdges = new Set<string>()
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const clause = statement.importClause
      if (!clause) continue // side-effect import 也是值边
      const bindings = clause.namedBindings
      const allTypeOnly =
        clause.isTypeOnly
        || (bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly))
      if (allTypeOnly && clause.name === undefined) continue
      valueEdges.add(statement.moduleSpecifier.text)
    }
    expect([...valueEdges].sort()).toEqual(["~/lib/anthropic/refusal-policy", "~/lib/anthropic/sanitize/separator-carrier"])
  })

  // ── 单一 owner：旧模块只剩 re-export，不许自己再声明一份 ────────────────────────
  test("recover-refusal 不再自己声明那三个 refusal 默认值（只 re-export）", () => {
    const declared = locallyDeclaredNames(parse("src/lib/anthropic/recover-refusal.ts"))
    expect(MOVED_TO_REFUSAL_POLICY.filter((name) => declared.has(name))).toEqual([])
  })

  test("block-layout-contract 不再自己声明分隔符载体词汇（只 re-export）", () => {
    const declared = locallyDeclaredNames(parse("src/lib/anthropic/sanitize/block-layout-contract.ts"))
    expect(MOVED_TO_SEPARATOR_CARRIER.filter((name) => declared.has(name))).toEqual([])
  })

  // ── 逐字 golden：SCC 数字对字符串内容完全不敏感，typecheck 也抓不住搬运时手滑改了一个字 ──
  test("三个 refusal 默认值逐字不变", () => {
    expect(DEFAULT_REFUSAL_ERROR_TYPE).toBe("api_error")
    expect(DEFAULT_REFUSAL_END_TURN_TEXT).toBe(
      "上游模型本轮以「拒绝（refusal）」结束，未产出可用回复（拒绝类别：{refusal_category}）。这是上游安全策略对本次请求的拦截，不代表任务本身有问题。请基于已有上下文换一种表述或拆分步骤后继续；若多次复现，考虑调整措辞、移除可能触发策略的内容，或改用其他模型。",
    )
    expect(DEFAULT_REFUSAL_ERROR_MESSAGE).toBe(
      "上游模型本轮以「拒绝（refusal）」结束、未产出可用回复（拒绝类别：{refusal_category}）。已按 error 策略中断本次请求。上游说明：{refusal_explanation}",
    )
  })

  test("分隔符载体逐字不变（它要在客户端历史里原样回流，改一个字就认不出旧的了）", () => {
    expect(DEFAULT_SEPARATOR_CARRIER).toBe("marker_v1")
    expect(SEPARATOR_CARRIERS).toEqual({ marker_v1: "[copilot-api:thinking-separator:v1]" })
  })

  // ── separator 这一对的完整契约（值与类型必须同源） ─────────────────────────────
  test("SeparatorCarrier 的 key union 与 SEPARATOR_CARRIERS 编译期一致", () => {
    // 编译期断言：两个方向都可赋值 ⇒ 两个 union 等价。任一侧漂移都会在 typecheck 变红。
    const forward: keyof typeof SEPARATOR_CARRIERS = DEFAULT_SEPARATOR_CARRIER
    const backward: typeof DEFAULT_SEPARATOR_CARRIER = "marker_v1" satisfies keyof typeof SEPARATOR_CARRIERS
    expect([forward, backward]).toEqual(["marker_v1", "marker_v1"])
    // 运行期兜底：默认载体必须真的在表里（编译期等价挡不住表为空这种退化）。
    expect(Object.keys(SEPARATOR_CARRIERS)).toContain(DEFAULT_SEPARATOR_CARRIER)
  })

  test("separatorText 的默认取自同一个 owner", () => {
    expect(separatorText()).toBe(SEPARATOR_CARRIERS[DEFAULT_SEPARATOR_CARRIER])
  })

  // ── 原公共路径不能断：这两个文件是既有消费者的入口 ─────────────────────────────
  test.each([
    ["src/lib/anthropic/sanitize/block-layout-contract.ts", "~/lib/anthropic/sanitize/block-layout-contract"],
    ["src/lib/anthropic/sanitize/assistant-block-layout.ts", "~/lib/anthropic/sanitize/assistant-block-layout"],
  ])("%s 仍然对外提供分隔符词汇", async (_rel, specifier) => {
    const module_ = (await import(specifier)) as Record<string, unknown>
    expect(module_.DEFAULT_SEPARATOR_CARRIER).toBe("marker_v1")
    expect(module_.SEPARATOR_CARRIERS).toEqual({ marker_v1: "[copilot-api:thinking-separator:v1]" })
    expect(typeof module_.separatorText).toBe("function")
  })

  test("recover-refusal 仍然对外提供三个 refusal 默认值", async () => {
    const module_ = (await import("~/lib/anthropic/recover-refusal")) as Record<string, unknown>
    expect(module_.DEFAULT_REFUSAL_ERROR_TYPE).toBe(DEFAULT_REFUSAL_ERROR_TYPE)
    expect(module_.DEFAULT_REFUSAL_END_TURN_TEXT).toBe(DEFAULT_REFUSAL_END_TURN_TEXT)
    expect(module_.DEFAULT_REFUSAL_ERROR_MESSAGE).toBe(DEFAULT_REFUSAL_ERROR_MESSAGE)
  })
})
