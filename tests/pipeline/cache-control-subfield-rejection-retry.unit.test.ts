import { afterEach, describe, expect, test } from "bun:test"

import type { ApiError } from "~/lib/error"

import {
  getUnsupportedCacheControlSubfields,
  markAnthropicUnsupportedCacheControlSubfield,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import {
  createCacheControlSubfieldRejectionStrategy,
  parseRejectedCacheControlSubfields,
} from "~/lib/request/strategies/cache-control-subfield-rejection-retry"
import { parseExtraInputsError } from "~/lib/request/strategies/context-management-retry"
import { parseRejectedToolFields } from "~/lib/request/strategies/tool-field-rejection-retry"

afterEach(async () => {
  await resetAnthropicFeatureNegotiationForTesting()
})

function ccError(msg: string): ApiError {
  return { type: "bad_request", status: 400, message: msg, raw: undefined } as never as ApiError
}

describe("cacheControlSubfields negotiation", () => {
  test("mark → get 往返（endpoint-level）", () => {
    markAnthropicUnsupportedCacheControlSubfield("scope")
    expect(getUnsupportedCacheControlSubfields()).toContain("scope")
  })
})

describe("三路径遮蔽（红线4）", () => {
  const paths = [
    "system.1.cache_control.ephemeral.scope: Extra inputs are not permitted",
    "tools.0.cache_control.ephemeral.scope: Extra inputs are not permitted", // 最险：共享 tools. 前缀
    "messages.0.content.1.cache_control.ephemeral.scope: Extra inputs are not permitted",
  ]
  test("新腿认领全部三路径", () => {
    for (const p of paths) expect(parseRejectedCacheControlSubfields(ccError(p))).toEqual(["scope"])
  })
  test("tool-field 腿绝不误认领 cache_control 路径（含 tools. 前缀那条）", () => {
    for (const p of paths) expect(parseRejectedToolFields(ccError(p))).toBeNull()
  })
  // MEDIUM-1（合并态审查）：body-field 腿注册在 cache-control 之前，是真正的 first-match 遮蔽风险来源，
  // 必须守其 lookbehind 对点分路径不误认领（spec §6.3 要求双 matcher 断言）。
  test("body-field 腿绝不误认领 cache_control 路径（lookbehind 排除点分路径）", () => {
    for (const p of paths) expect(parseExtraInputsError(p)).toBeNull()
  })
})

describe("解析与重试", () => {
  test("matchAll 多字段一次剥", () => {
    const e = ccError(
      "system.1.cache_control.ephemeral.scope: Extra inputs are not permitted\nsystem.2.cache_control.ephemeral.foo: Extra inputs are not permitted",
    )
    expect(parseRejectedCacheControlSubfields(e)!.sort()).toEqual(["foo", "scope"])
  })

  test("非 cache_control 类 400 返 null", () => {
    expect(parseRejectedCacheControlSubfields(ccError("tools.0.custom.eager_input_streaming: Extra inputs are not permitted"))).toBeNull()
  })

  test("canHandle → handle：mark + prepareHints 剥掉重试", async () => {
    const strat = createCacheControlSubfieldRejectionStrategy<{ model: string }>()
    const err = ccError("system.1.cache_control.ephemeral.scope: Extra inputs are not permitted")
    expect(strat.canHandle(err)).toBe(true)
    const action = await strat.handle(err, { model: "claude-opus-4-8" }, { attempt: 0, maxRetries: 3, originalPayload: { model: "claude-opus-4-8" }, model: undefined })
    expect(action.action).toBe("retry")
    if (action.action === "retry") {
      expect(action.prepareHints?.excludeCacheControlSubfields).toEqual(["scope"])
    }
    expect(getUnsupportedCacheControlSubfields()).toContain("scope")
  })
})
