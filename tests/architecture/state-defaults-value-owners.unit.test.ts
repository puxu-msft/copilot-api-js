/**
 * The state unit declares its own default VALUES, and the domains that consume them import them back.
 *
 * History, because the judgement here changed twice and the reason matters
 * (docs/plan/2026-07-28-state-to-foundation/HANDOVER.md): `state-defaults.ts` used to read three
 * refusal templates and the separator carrier FROM the anthropic domain, and those two value edges
 * alone kept `state` + `state-defaults` inside 52 and 50 of the repo's 70 import cycles. S1 pointed
 * them at zero-import leaves instead, which measured 70/63 → 30/43 — but a leaf target only fixes the
 * CYCLE. The foundation boundary rejects a `~/` import whether or not its target is a leaf, so S5
 * finished the job by moving ownership: `state-defaults` declares the four constants, and
 * `anthropic/refusal-policy` + `anthropic/sanitize/separator-carrier` re-export them.
 *
 * So the criterion this file enforces was deliberately tightened from "value edges point at leaves"
 * to "no cross-module value edges at all". Keeping the old, weaker form would have passed happily
 * while S6 was still blocked.
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
  SEPARATOR_CARRIERS,
  separatorText,
} from "~/lib/anthropic/sanitize/separator-carrier"
import {
  //
  DEFAULT_REFUSAL_END_TURN_TEXT,
  DEFAULT_REFUSAL_ERROR_MESSAGE,
  DEFAULT_REFUSAL_ERROR_TYPE,
  DEFAULT_SEPARATOR_CARRIER,
} from "~/lib/state-defaults"

import {
  //
  allModuleSpecifiers,
  parseSource,
  typeOnlyModuleSpecifiers,
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

const MOVED_DEFAULTS = ["DEFAULT_REFUSAL_END_TURN_TEXT", "DEFAULT_REFUSAL_ERROR_MESSAGE", "DEFAULT_REFUSAL_ERROR_TYPE"]

describe("state-defaults 自持默认值，零跨模块值出边", () => {
  test("state-defaults 的唯一出边是零依赖词汇叶子，且是纯类型", () => {
    const sourceFile = parse("packages/foundation/src/state-defaults.ts")
    expect(outEdges("packages/foundation/src/state-defaults.ts")).toEqual(["./state-vocabulary"])
    // 值边为零：唯一那条必须是 type-only，否则 S6 的文件级 allowlist 仍会拒。
    expect(typeOnlyModuleSpecifiers(sourceFile)).toEqual(["./state-vocabulary"])
  })

  test("词汇叶子零出边（它的叶子身份就是它的全部价值）", () => {
    expect(outEdges("packages/foundation/src/state-vocabulary.ts"), "state-vocabulary 一旦有出边，state 与 state-defaults 就都跟着不再是叶子").toEqual([])
  })

  // ── 单一 owner：旧模块只剩 re-export，不许自己再声明一份 ────────────────────────
  test.each([
    ["src/lib/anthropic/recover-refusal.ts", MOVED_DEFAULTS],
    ["src/lib/anthropic/refusal-policy.ts", MOVED_DEFAULTS],
    ["src/lib/anthropic/sanitize/separator-carrier.ts", ["DEFAULT_SEPARATOR_CARRIER"]],
    ["src/lib/anthropic/sanitize/block-layout-contract.ts", ["DEFAULT_SEPARATOR_CARRIER", "SEPARATOR_CARRIERS", "separatorText"]],
  ])("%s 只 re-export、不再自己声明这些默认值", (rel, names) => {
    const declared = locallyDeclaredNames(parse(rel))
    expect(names.filter((name) => declared.has(name))).toEqual([])
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
