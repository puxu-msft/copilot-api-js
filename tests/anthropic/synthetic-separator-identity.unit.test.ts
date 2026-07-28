/**
 * 合成分隔符的**身份**守卫。
 *
 * 这个 marker 是我方唯一会主动写进 assistant 消息、并且预期**从客户端历史里原样回流**的合成物
 * （ADR `2026-07-05-richest-data-flow`：合成物必打可辨识标记）。它的身份只能落在文本本身上——
 * 进程内的 Symbol/WeakSet 活不过「客户端下一轮把它重投回来」这一跳，而那正是我们需要认出它的时刻。
 *
 * 因此这里钉三件事：
 *   1. 认得出**每一个历史拼法**（换措辞不能把已 baked 进客户端历史的 marker 变成认不出的垃圾）；
 *   2. 不误伤真实内容（模型/用户写的普通文本不能被当成 marker 剥掉）；
 *   3. 身份判断**只有一处**——除了拥有它的模块，源码里任何地方都不得直接与字面量比较。
 */

import { Glob } from "bun"
import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import ts from "typescript"

import type { ContentBlockParam } from "~/types/api/anthropic"

import {
  //
  isSyntheticThinkingSeparator,
  makeSyntheticSeparator,
  SEPARATOR_CARRIERS,
  separatorText,
} from "~/lib/anthropic/sanitize/assistant-block-layout"
import { stripAllThinking } from "~/lib/anthropic/strip-all-thinking"

import { parseSource } from "../architecture/source-ast"

const text = (t: string): ContentBlockParam => ({ type: "text", text: t }) as ContentBlockParam
const OWNERS = new Set([
  "src/lib/anthropic/sanitize/separator-carrier.ts",
  "src/lib/anthropic/sanitize/block-layout-contract.ts",
  "src/lib/anthropic/sanitize/assistant-block-layout.ts",
])
/** 2026-07-27 更名前唯一的拼法；客户端历史里仍可能带着它。 */
const LEGACY_SPELLING = "[copilot-api: thinking separator]"

describe("synthetic separator identity", () => {
  test("产出的 marker 认得出自己（往返）", () => {
    expect(isSyntheticThinkingSeparator(makeSyntheticSeparator())).toBe(true)
    expect(isSyntheticThinkingSeparator(text(separatorText()))).toBe(true)
  })

  test("认得出旧版本拼法（否则换措辞会把已回流的 marker 变成认不出的垃圾）", () => {
    expect(isSyntheticThinkingSeparator(text(LEGACY_SPELLING))).toBe(true)
  })

  test("认得出未来的版本号变体（前缀族匹配，不是单一冻结字面量）", () => {
    expect(isSyntheticThinkingSeparator(text("[copilot-api:thinking-separator:v9]"))).toBe(true)
  })

  test("客户端可能加的空白不影响识别", () => {
    expect(isSyntheticThinkingSeparator(text(` ${separatorText()}\n`))).toBe(true)
  })

  test("不误伤真实内容", () => {
    expect(isSyntheticThinkingSeparator(text("thinking separator"))).toBe(false)
    expect(isSyntheticThinkingSeparator(text("我在讨论 [copilot-api:thinking-separator:v1] 这个标记"))).toBe(false) // 非前导
    expect(isSyntheticThinkingSeparator(text(""))).toBe(false)
    expect(isSyntheticThinkingSeparator({ type: "tool_use", id: "t", name: "x", input: {} } as ContentBlockParam)).toBe(false)
  })

  // strip-all 是这个谓词的真实消费者：thinking 被剥走后，marker 就是无意义的孤儿，必须一起清掉，
  // 否则会作为一条突兀的合成文本泄漏给上游。旧拼法同样要被清掉。
  test("strip-all 会连同旧拼法的孤儿 marker 一起清掉", () => {
    const { messages, strippedCount } = stripAllThinking([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "", signature: "s" }, text(LEGACY_SPELLING), makeSyntheticSeparator(), text("real")] as never,
      },
    ])
    expect((messages[0].content as Array<{ type: string; text?: string }>).map((b) => b.text)).toEqual(["real"])
    expect(strippedCount).toBe(3)
  })

  // ── 两条轴的不对称性（用户 2026-07-27 决定）：发射端封闭、识别端开放 ──────────────
  // 加一个可接受值只会扩大识别面（永远造不出非法 payload）；发射端若开放成自由字符串，
  // 用户填个纯空白就能自造 400——这正是本 pass 存在的理由。

  test("ACCEPT 轴：运维 pin 的历史字面量会被认出（迁移与第三方值靠这条活）", () => {
    const legacyFromSomeOtherDeployment = "<<sep-from-an-older-fork>>"
    expect(isSyntheticThinkingSeparator(text(legacyFromSomeOtherDeployment))).toBe(false) // 未 pin：不认
    expect(isSyntheticThinkingSeparator(text(legacyFromSomeOtherDeployment), [legacyFromSomeOtherDeployment])).toBe(true) // pin 后：认
  })

  test("ACCEPT 轴是单调的：pin 任何东西都不会让内建族/旧拼法失效", () => {
    for (const extra of [[], ["<<x>>"], ["completely", "unrelated", "values"]]) {
      expect(isSyntheticThinkingSeparator(text(separatorText()), extra)).toBe(true)
      expect(isSyntheticThinkingSeparator(text(LEGACY_SPELLING), extra)).toBe(true)
    }
  })

  test("ACCEPT 轴按整块 trim 后全等比较，不做子串匹配（否则会误吃正常消息）", () => {
    const pinned = "SEP"
    expect(isSyntheticThinkingSeparator(text("SEP"), [pinned])).toBe(true)
    expect(isSyntheticThinkingSeparator(text("这段话里提到了 SEP 这个词"), [pinned])).toBe(false)
    expect(isSyntheticThinkingSeparator(text(""), [""])).toBe(false) // 空块永远不算——pin 空串也不行
  })

  test("EMIT 轴：发射值取自载体表，且产出的块必然被自己认出（往返闭合）", () => {
    expect(Object.values<string>(SEPARATOR_CARRIERS)).toContain(separatorText())
    for (const carrier of Object.keys(SEPARATOR_CARRIERS) as Array<keyof typeof SEPARATOR_CARRIERS>) {
      expect(isSyntheticThinkingSeparator(text(separatorText(carrier)))).toBe(true)
    }
  })

  test("EMIT 轴上的每个载体都必须是 trim 后非空的（空白载体会被上游 strip → 自造 400）", () => {
    for (const [name, value] of Object.entries(SEPARATOR_CARRIERS)) {
      expect(value.trim().length, `carrier ${name} is blank — upstream strips it and the repair silently fails`).toBeGreaterThan(0)
    }
  })

  // 身份判断必须单点。两种漂移都要挡：写死字面量（换版本号就漏），以及 import 常量后自己
  // `=== SEPARATOR_CARRIERS.marker_v1` 这种绕过谓词的自比较（正是 2026-07-27 前 strip-all 的写法——它认不出
  // 任何旧拼法）。src/ 里的消费者一律只准用谓词。
  // 两半判据形状不同，因为它们要挡的东西不同：
  //   * 字面量 —— 文本扫描。写死的 marker 文本无论出现在代码、注释还是字符串里都是隐患。
  //   * 载体表 —— **AST**。要挡的是「有人 import 了发射常量、绕过谓词自比较」，而不是「有人在文档
  //     注释里提到了表名」。原本这半也是 `content.includes("SEPARATOR_CARRIERS")`，于是
  //     `state-vocabulary.ts` 里一句解释这张表的注释就把守卫打红了——判据形状错了，正确反应是换判据
  //     形状，不是把注释改成不敢提表名。
  test("src/ 里除拥有者外不出现载体字面量（文本扫描：注释/字符串里写死也算）", () => {
    const root = new URL("../..", import.meta.url).pathname
    const hits = [...new Glob("**/*.ts").scanSync({ cwd: `${root}/src`, onlyFiles: true })]
      .map((rel) => `src/${rel}`)
      .filter((path) => !OWNERS.has(path))
      .filter((path) => {
        const content = readFileSync(`${root}/${path}`, "utf8")
        return content.includes("copilot-api:thinking-separator") || content.includes(LEGACY_SPELLING)
      })
    expect(hits, `这些文件写死了合成分隔符字面量，应改用 isSyntheticThinkingSeparator():\n${hits.join("\n")}`).toEqual([])
  })

  test("src/ 里除拥有者外不 import 载体表（AST：只有真引用算，注释提到不算）", () => {
    const root = new URL("../..", import.meta.url).pathname
    const hits = [...new Glob("**/*.ts").scanSync({ cwd: `${root}/src`, onlyFiles: true })]
      .map((rel) => `src/${rel}`)
      .filter((path) => !OWNERS.has(path))
      .filter((path) => {
        const content = readFileSync(`${root}/${path}`, "utf8")
        // 子串预过滤挡在 AST 走查前面：标识符必然逐字出现，所以没有它的文件不可能引用载体表——
        // 预过滤只可能少扫、不可能漏报，而 AST 仍然负责排除注释/字符串里的同名文本。全扫 ~700 个文件
        // 的 AST 单跑就 1.3s，16 路分片下会撞爆默认 5s 超时（peer 的 382b561b 踩过同一个坑）。
        if (!content.includes("SEPARATOR_CARRIERS")) return false
        const sourceFile = parseSource(path, content)
        let found = false
        const visit = (node: ts.Node): void => {
          if (ts.isIdentifier(node) && node.text === "SEPARATOR_CARRIERS") found = true
          ts.forEachChild(node, visit)
        }
        visit(sourceFile)
        return found
      })
    expect(hits, `这些文件引用了发射端载体表、绕过了谓词，应改用 isSyntheticThinkingSeparator():\n${hits.join("\n")}`).toEqual([])
  })

  test("守卫有效性：合成正样本会被 AST 判据抓到（否则「零命中」只说明扫描没触达）", () => {
    const planted = parseSource("synthetic.ts", 'import { SEPARATOR_CARRIERS as t } from "x"\nconst a = t.marker_v1\n')
    let found = false
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "SEPARATOR_CARRIERS") found = true
      ts.forEachChild(node, visit)
    }
    visit(planted)
    expect(found).toBe(true)
  })
})
