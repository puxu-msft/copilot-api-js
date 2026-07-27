/**
 * L2 reactive strip-all retry — the guarded matcher AND the `canHandle`/`handle` decision
 * gates for GHC's illegal-layout 400s: the "cannot be modified" adjacency shape (C1), the
 * "final block ... cannot be `thinking`" terminal shape (C2), and the misleadingly-worded
 * "does not support assistant message prefill" shape (C3, conditional remedy).
 *
 * Two layers are asserted:
 *   1. The pure `isThinkingLayoutRejection(string)` matcher. It MUST fire on
 *      both real rejection bodies, and it MUST NOT fire on the legacy
 *      `thinking.type.enabled` rejection (handled by a separate strategy) or on
 *      an unrelated 400 — a false positive would strip thinking from turns the
 *      upstream never complained about.
 *   2. `createPoisonedThinkingRetryStrategy().canHandle(error)` end-to-end,
 *      driving the non-obvious `extractMessage` path: the terse classified
 *      `message` does NOT carry the phrase, so the decision hinges on parsing
 *      `error.raw.responseText` as JSON `{ error: { message } }` (or falling
 *      back to raw text). That body-parse branch is the reactive fallback's real
 *      wire behaviour and had zero coverage before.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { RetryAction } from "~/lib/pipeline/types"

import {
  //
  classifyLayoutRejection,
  isThinkingLayoutRejection,
  isToolTerminalPrefillRejection,
} from "~/lib/anthropic/poisoned-thinking-match"
import { SYNTHETIC_THINKING_SEPARATOR } from "~/lib/anthropic/sanitize/assistant-block-layout"
import { createPoisonedThinkingRetryStrategy } from "~/lib/codec/anthropic/poisoned-thinking-retry"
import {
  //
  classifyError,
  HTTPError,
} from "~/lib/error"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

describe("isThinkingLayoutRejection", () => {
  test("正命中真实 body", () => {
    expect(
      isThinkingLayoutRejection(
        "messages.3.content.34: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.",
      ),
    ).toBe(true)
  })

  test("负命中 legacy thinking.type.enabled", () => {
    expect(isThinkingLayoutRejection('"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive"')).toBe(false)
  })

  test("负命中无关 400", () => {
    expect(isThinkingLayoutRejection("messages.0: Extra inputs are not permitted")).toBe(false)
  })

  // C2：末块 thinking 的 400 是另一种措辞（无 “cannot be modified”），但同样由
  // strip-all 治愈，故共用本谓词。真实 body 取自 req_1785016294183_896。
  test("正命中 C2 终端块拒绝（真实 body）", () => {
    expect(isThinkingLayoutRejection("messages.27: The final block in an assistant message cannot be `thinking`.")).toBe(true)
  })

  test("负命中：只提到 thinking 但不是布局拒绝", () => {
    expect(isThinkingLayoutRejection("thinking budget_tokens must be greater than 1024")).toBe(false)
  })

  test("负命中：final block 措辞但主语不是 assistant message", () => {
    expect(isThinkingLayoutRejection("The final block in a user message cannot be `image`.")).toBe(false)
  })

  // 上游用同一句式报告其它块类型的 final-block 违规；strip-all 治不了它们，
  // 认领只会白烧掉一次性重试机会并遮蔽真正的处理策略（评审 MED-1）。
  test.each(["`tool_use`", "`text`", "empty"])("负命中：同句式但被拒块是 %s（非 thinking）", (blockKind) => {
    expect(isThinkingLayoutRejection(`messages.9: The final block in an assistant message cannot be ${blockKind}.`)).toBe(false)
  })

  // 块类型必须紧跟线索本身，而非「消息里某处出现 thinking」——否则一条因别的原因
  // 提到 thinking 的 final-block 400 会被误认领（复审 MED，clause-local 收窄）。
  test("负命中：消息别处提到 thinking，但被拒块是 tool_use", () => {
    expect(isThinkingLayoutRejection("Thinking is enabled, but the final block in an assistant message cannot be `tool_use`.")).toBe(false)
  })

  test("正命中：redacted_thinking 变体与引号风格容忍", () => {
    expect(isThinkingLayoutRejection("The final block in an assistant message cannot be `redacted_thinking`.")).toBe(true)
    expect(isThinkingLayoutRejection("The final block in an assistant message cannot be thinking.")).toBe(true)
  })
})

describe("createPoisonedThinkingRetryStrategy().canHandle — body-parse extraction", () => {
  // 显式设 state 门禁，避免依赖环境默认或跨用例污染；每个用例后自动回滚。
  autoRestoreState()

  // 真实拒绝 body：JSON 信封 `{ error: { message } }`，短语在 message 里。
  const POISON_BODY =
    '{"error":{"message":"messages.3.content.34: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."}}'

  test("正命中：顶层 message 不含短语，走 raw.responseText 的 JSON error.message 提取", () => {
    setStateForTests({ stripThinkingOnReject: true })
    // 真实分类器：400 + 非 token-limit/非 rate-limit body → bad_request，raw 为原始 HTTPError。
    const error = classifyError(new HTTPError("400 Bad Request", 400, POISON_BODY))
    // oracle：确认确实走 body-parse 分支——已归类为 bad_request/400，且顶层 message 不含短语
    // （否则 extractThinkingRejectMessage 会在第一行短路，测不到 JSON 解析路径）。
    expect(error.type).toBe("bad_request")
    expect(error.status).toBe(400)
    expect(error.message.toLowerCase()).not.toContain("cannot be modified")
    expect(createPoisonedThinkingRetryStrategy().canHandle(error)).toBe(true)
  })

  test("负命中：body 是无关 400（Extra inputs are not permitted）", () => {
    setStateForTests({ stripThinkingOnReject: true })
    const body = '{"error":{"message":"messages.0: Extra inputs are not permitted"}}'
    const error = classifyError(new HTTPError("400 Bad Request", 400, body))
    expect(error.type).toBe("bad_request")
    expect(error.status).toBe(400)
    expect(createPoisonedThinkingRetryStrategy().canHandle(error)).toBe(false)
  })

  test("非 JSON body：JSON.parse 抛错 → catch 回退到原始文本仍命中", () => {
    setStateForTests({ stripThinkingOnReject: true })
    // 原始非 JSON 文本，同时含 “cannot be modified” 与 “thinking”。
    const body = "upstream error: thinking blocks cannot be modified — must remain as original"
    const error = classifyError(new HTTPError("400 Bad Request", 400, body))
    expect(error.type).toBe("bad_request")
    expect(createPoisonedThinkingRetryStrategy().canHandle(error)).toBe(true)
  })

  test("state 门禁：stripThinkingOnReject=false 时即便 body 命中也不接管", () => {
    setStateForTests({ stripThinkingOnReject: false })
    const error = classifyError(new HTTPError("400 Bad Request", 400, POISON_BODY))
    // body 本身会命中匹配，但 canHandle 应因 state 门禁短路返回 false。
    expect(createPoisonedThinkingRetryStrategy().canHandle(error)).toBe(false)
  })

  test("正命中 C2：终端块拒绝 body 同样经 body-parse 接管（L1 未预防时的兜底腿）", () => {
    setStateForTests({ stripThinkingOnReject: true })
    const body = '{"error":{"message":"messages.27: The final block in an assistant message cannot be `thinking`.","type":"invalid_request_error"}}'
    const error = classifyError(new HTTPError("400 Bad Request", 400, body))
    expect(error.type).toBe("bad_request")
    expect(error.message.toLowerCase()).not.toContain("final block")
    expect(createPoisonedThinkingRetryStrategy().canHandle(error)).toBe(true)
  })
})

/**
 * C3（prefill 措辞）的认领与治愈判据。真实 body 取自 req_1785160010003_3754：陈旧实例的
 * de-stack 把 `[T,text(""),T,tool]` 变成 `[T,tool,T]`，上游用一句**与 thinking / tool_use
 * 都无关**的措辞回绝，L2 因此完全不认领 → 客户端吃到硬 400、零兜底。
 *
 * 认领之后仍要分辨：strip-all 只治得了「thinking 把 tool_use 挤离末尾」这一种；对**以 assistant
 * 轮收尾**的对话（同一措辞覆盖的字面 prefill）它无能为力，此时必须 abort 而不是白烧掉一次性重试。
 * 注意判据是「末条是 assistant」而**不是**「末条不是 user」——内联 `role:"system"` 收尾实测得 200
 * （真上游对照：`[user,system]` / `[user,assistant,user,system]` 皆 200，`[user,assistant]` 才 400）。
 */
describe("C3 / prefill 400：认领 + 条件治愈", () => {
  autoRestoreState()

  const PREFILL_BODY =
    '{"type":"error","error":{"type":"invalid_request_error","message":"This model does not support assistant message prefill. The conversation must end with a user message."},"request_id":"req_011CdSfYkFaWerhb4y2PDG86"}'
  const prefillError = () => classifyError(new HTTPError("400 Bad Request", 400, PREFILL_BODY))

  const T = { type: "thinking", thinking: "", signature: "sig" }
  const toolUse = { type: "tool_use", id: "toolu_1", name: "Bash", input: {} }
  const toolResult = { type: "tool_result", tool_use_id: "toolu_1", content: "ok" }
  const SEP = { type: "text", text: SYNTHETIC_THINKING_SEPARATOR }
  /** 真实形状的对话：assistant 轮 + 对应的 tool_result user 轮（除非显式要求以 assistant 收尾）。 */
  const envFor = (assistantTurns: Array<Array<unknown>>, tail: "user" | "assistant" = "user"): RequestEnvelope => {
    const messages: Array<unknown> = []
    for (const content of assistantTurns) {
      messages.push({ role: "assistant", content }, { role: "user", content: [toolResult] })
    }
    if (tail === "assistant") messages.pop()
    return {
      body: { model: "claude-opus-5", max_tokens: 1024, messages },
      ctx: {},
      with(patch: { body: unknown }) {
        return { ...this, ...patch } as RequestEnvelope
      },
    } as unknown as RequestEnvelope
  }
  const contentOf = (action: RetryAction, index: number): Array<{ type: string }> =>
    (action as { env: { body: { messages: Array<{ content: Array<{ type: string }> }> } } }).env.body.messages[index].content

  test("措辞分类：prefill 归 tool-terminal-prefill，与 thinking-layout 分开", () => {
    expect(isToolTerminalPrefillRejection("This model does not support assistant message prefill. The conversation must end with a user message.")).toBe(true)
    expect(isThinkingLayoutRejection("This model does not support assistant message prefill. The conversation must end with a user message.")).toBe(false)
    expect(classifyLayoutRejection(prefillError())).toBe("tool-terminal-prefill")
  })

  test("canHandle：prefill 400 现在被接管（此前是零兜底的硬 400）", () => {
    setStateForTests({ stripThinkingOnReject: true })
    expect(createPoisonedThinkingRetryStrategy().canHandle(prefillError())).toBe(true)
  })

  test("handle：thinking 造成的 C3（[T,tool,T]）→ 剥 thinking 重试", async () => {
    setStateForTests({ stripThinkingOnReject: true })
    const action = await createPoisonedThinkingRetryStrategy().handle(prefillError(), envFor([[T, toolUse, T]]))
    expect(action.kind).toBe("retry")
    expect(contentOf(action, 0).map((b) => b.type)).toEqual(["tool_use"]) // 剥完 tool_use 自然收尾
  })

  test("handle：L1 合成分隔符拖尾（[tool,T,SEP]，insert_text 腿的已知形态）→ 重试；判据必须用真实 strip 结果", async () => {
    setStateForTests({ stripThinkingOnReject: true })
    // strip-all 连同孤儿合成 marker 一起删 → `[tool]` 合法。若判据自己「只过滤 thinking」来模拟，
    // 会算出 `[tool, SEP]` 仍违规而误 abort —— 正是最该兜住 insert_text 腿的时候失手。
    const action = await createPoisonedThinkingRetryStrategy().handle(prefillError(), envFor([[toolUse, T, SEP]]))
    expect(action.kind).toBe("retry")
    expect(contentOf(action, 0).map((b) => b.type)).toEqual(["tool_use"])
  })

  test("handle：多条违规且**全部**可治愈 → 重试，每条都被剥成合法", async () => {
    setStateForTests({ stripThinkingOnReject: true })
    // 合取判据的正向对照：只有「一条可治愈 + 一条不可治愈 → abort」的反向用例时，
    // 一个「只要有一条可治愈就重试」的错误实现照样全绿。
    const action = await createPoisonedThinkingRetryStrategy().handle(
      prefillError(),
      envFor([
        [T, toolUse, T],
        [T, toolUse, T],
      ]),
    )
    expect(action.kind).toBe("retry")
    expect(contentOf(action, 0).map((b) => b.type)).toEqual(["tool_use"])
    expect(contentOf(action, 2).map((b) => b.type)).toEqual(["tool_use"]) // 第二条 assistant（中间隔着 user 轮）
  })

  test("handle：内联 system 消息收尾**不算** prefill → 照常重试（真上游实测 [user,system] 得 200）", async () => {
    setStateForTests({ stripThinkingOnReject: true })
    const env = envFor([[T, toolUse, T]])
    const withSystemTail = env.with({
      body: {
        ...(env.body as { messages: Array<unknown> }),
        messages: [...(env.body as { messages: Array<unknown> }).messages, { role: "system", content: "mid-turn note" }],
      },
    } as never)
    const action = await createPoisonedThinkingRetryStrategy().handle(prefillError(), withSystemTail)
    expect(action.kind).toBe("retry")
  })

  test("handle：非 thinking 造成的 C3（[tool,text]）→ abort，不白烧重试", async () => {
    setStateForTests({ stripThinkingOnReject: true })
    const action = await createPoisonedThinkingRetryStrategy().handle(prefillError(), envFor([[toolUse, { type: "text", text: "trailing" }]]))
    expect(action.kind).toBe("abort")
  })

  test("handle：一条可治愈 + 另一条治不了（[tool,text]）→ 整体 abort，绝不发已知仍违规的 payload", async () => {
    setStateForTests({ stripThinkingOnReject: true })
    const action = await createPoisonedThinkingRetryStrategy().handle(
      prefillError(),
      envFor([
        [T, toolUse, T],
        [toolUse, { type: "text", text: "trailing" }],
      ]),
    )
    expect(action.kind).toBe("abort")
  })

  test("handle：对话以 assistant 收尾（字面 prefill）→ abort，即便块级 C3 剥了能修", async () => {
    setStateForTests({ stripThinkingOnReject: true })
    const action = await createPoisonedThinkingRetryStrategy().handle(prefillError(), envFor([[T, toolUse, T]], "assistant"))
    expect(action.kind).toBe("abort")
  })

  test("handle：无任何 C3 违规（合法布局）→ abort，不拿 strip-all 当万金油", async () => {
    setStateForTests({ stripThinkingOnReject: true })
    const action = await createPoisonedThinkingRetryStrategy().handle(prefillError(), envFor([[T, { type: "text", text: "hi" }, toolUse]]))
    expect(action.kind).toBe("abort")
  })

  test("C1/C2 腿不受本条件门影响：thinking-layout 400 仍无条件 strip-all 重试", async () => {
    setStateForTests({ stripThinkingOnReject: true })
    const body = '{"error":{"message":"messages.27: The final block in an assistant message cannot be `thinking`."}}'
    const error = classifyError(new HTTPError("400 Bad Request", 400, body))
    // 布局合法（tool_use 收尾）→ C3 条件门若误加到这条腿上就会 abort。
    const action = await createPoisonedThinkingRetryStrategy().handle(error, envFor([[T, { type: "text", text: "hi" }, toolUse]]))
    expect(action.kind).toBe("retry")
  })

  test("state 门禁对 C3 一样生效", () => {
    setStateForTests({ stripThinkingOnReject: false })
    expect(createPoisonedThinkingRetryStrategy().canHandle(prefillError())).toBe(false)
  })

  test("负命中：只提 prefill 但不是本措辞的 400 不认领", () => {
    setStateForTests({ stripThinkingOnReject: true })
    const body = '{"error":{"message":"prefill is not allowed for streaming requests"}}'
    expect(createPoisonedThinkingRetryStrategy().canHandle(classifyError(new HTTPError("400 Bad Request", 400, body)))).toBe(false)
  })
})
