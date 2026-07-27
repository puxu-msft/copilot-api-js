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

import type { ContentBlockParam } from "~/types/api/anthropic"

import {
  //
  isSyntheticThinkingSeparator,
  makeSyntheticSeparator,
  SYNTHETIC_THINKING_SEPARATOR,
} from "~/lib/anthropic/sanitize/assistant-block-layout"
import { stripAllThinking } from "~/lib/anthropic/strip-all-thinking"

const text = (t: string): ContentBlockParam => ({ type: "text", text: t }) as ContentBlockParam
const OWNER = "src/lib/anthropic/sanitize/assistant-block-layout.ts"
/** 2026-07-27 更名前唯一的拼法；客户端历史里仍可能带着它。 */
const LEGACY_SPELLING = "[copilot-api: thinking separator]"

describe("synthetic separator identity", () => {
  test("产出的 marker 认得出自己（往返）", () => {
    expect(isSyntheticThinkingSeparator(makeSyntheticSeparator())).toBe(true)
    expect(isSyntheticThinkingSeparator(text(SYNTHETIC_THINKING_SEPARATOR))).toBe(true)
  })

  test("认得出旧版本拼法（否则换措辞会把已回流的 marker 变成认不出的垃圾）", () => {
    expect(isSyntheticThinkingSeparator(text(LEGACY_SPELLING))).toBe(true)
  })

  test("认得出未来的版本号变体（前缀族匹配，不是单一冻结字面量）", () => {
    expect(isSyntheticThinkingSeparator(text("[copilot-api:thinking-separator:v9]"))).toBe(true)
  })

  test("客户端可能加的空白不影响识别", () => {
    expect(isSyntheticThinkingSeparator(text(` ${SYNTHETIC_THINKING_SEPARATOR}\n`))).toBe(true)
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

  // 身份判断必须单点。两种漂移都要挡：写死字面量（换版本号就漏），以及 import 常量后自己
  // `=== SYNTHETIC_THINKING_SEPARATOR` 比较（正是 2026-07-27 前 strip-all 的写法——它认不出
  // 任何旧拼法）。src/ 里的消费者一律只准用谓词。
  test("src/ 里除拥有者外，既不出现字面量、也不引用该常量（消费者只准用谓词）", () => {
    const root = new URL("../..", import.meta.url).pathname
    const hits = [...new Glob("**/*.ts").scanSync({ cwd: `${root}/src`, onlyFiles: true })]
      .map((rel) => `src/${rel}`)
      .filter((path) => path !== OWNER)
      .filter((path) => {
        const content = readFileSync(`${root}/${path}`, "utf8")
        return content.includes("copilot-api:thinking-separator") || content.includes(LEGACY_SPELLING) || content.includes("SYNTHETIC_THINKING_SEPARATOR")
      })
    expect(hits, `这些文件直接比较合成分隔符字面量，应改用 isSyntheticThinkingSeparator():\n${hits.join("\n")}`).toEqual([])
  })
})
