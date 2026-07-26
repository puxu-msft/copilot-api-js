/**
 * L2 reactive strip-all retry — the guarded matcher AND the `canHandle` decision
 * gate for GHC's illegal-thinking-layout 400s (both the "cannot be modified"
 * adjacency shape and the "final block ... cannot be `thinking`" terminal shape).
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

import { isThinkingLayoutRejection } from "~/lib/anthropic/poisoned-thinking-match"
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
