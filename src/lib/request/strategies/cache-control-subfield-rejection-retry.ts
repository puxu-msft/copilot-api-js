/**
 * cache_control 子字段 rejection 反应式重试腿。
 *
 * GHC 上游拒绝 cache_control 内部的未知子字段（如 prompt-caching-scope beta 引入的 `scope`），报：
 *
 *   HTTP 400  <section>.N[...].cache_control.<variant>.<field>: Extra inputs are not permitted
 *
 * 三种 section 路径都可能：`system.1.cache_control.ephemeral.scope` /
 * `tools.0.cache_control.ephemeral.scope` / `messages.0.content.1.cache_control.ephemeral.scope`。
 * 学习该字段（endpoint-level，一次 400 免疫所有模型，对齐 tool-field-rejection），剥掉重试；
 * 学到的字段经 `collectUnsupportedCacheControlSubfields` 源③进入后续请求的 passthrough 预剥。
 *
 * 遮蔽安全（红线4，spec §6.3）：正则要求 `.cache_control.<variant>.<field>:` 四段路径，
 * tool-field 正则（`tools\.\d+\.\w+\.<field>:` 三段）对 `tools.0.cache_control.ephemeral.scope`
 * 不匹配（`ephemeral` 后是 `.` 非 `:`）；body-field 的 top-level lookbehind 也排除点分路径。
 * 三路径 disjointness 由回归测试独立证实。
 *
 * SAFETY：`Extra inputs are not permitted` = 上游根本不建模该子字段，剥掉无语义损失。
 * MODEL-AGNOSTIC：cache_control 子字段支持是上游版本属性，非 per-model。
 * MULTI-FIELD：pydantic 一次报告所有 offending 字段，`matchAll` 全部剥（单次重试）。
 */

import consola from "consola"

import { markAnthropicUnsupportedCacheControlSubfield } from "~/lib/anthropic/feature-negotiation"
import {
  //
  type ApiError,
  HTTPError,
} from "~/lib/error"

import type {
  //
  RetryAction,
  RetryContext,
  RetryStrategy,
} from "../retry-types"

/** 捕获每个 `...cache_control.<variant>.<field>: Extra inputs are not permitted` 的 field（去重）。 */
const CC_SUBFIELD_EXTRA_INPUTS = /\.cache_control\.\w+\.([a-z_]\w*): Extra inputs are not permitted/gi
/** 非 global 孪生正则，作廉价 presence 测试（matchAll 需 global flag）。导出为
 *  `mockUpstreamError.cacheControlSubfield` 自身 oracle 测试（~/lib/pipeline/hooks
 *  toolkit.unit.test.ts）的单一事实源正则，避免另抄一份漂移。 */
export const CC_SUBFIELD_PRESENT = /\.cache_control\.\w+\.[a-z_]\w*: Extra inputs are not permitted/i

function extractErrorText(error: ApiError): string | null {
  if (CC_SUBFIELD_PRESENT.test(error.message)) return error.message
  if (error.raw instanceof HTTPError) return error.raw.responseText
  return null
}

/** 解析上游拒绝的 cache_control 子字段集（去重），非此类 400 返 null。 */
export function parseRejectedCacheControlSubfields(error: ApiError): Array<string> | null {
  const text = extractErrorText(error)
  if (text === null) return null
  const fields = new Set<string>()
  for (const m of text.matchAll(CC_SUBFIELD_EXTRA_INPUTS)) fields.add(m[1])
  return fields.size > 0 ? [...fields] : null
}

export function createCacheControlSubfieldRejectionStrategy<TPayload extends { model: string }>(): RetryStrategy<TPayload> {
  // Per-instance one-shot guard. Strategies are built per-request → request-scoped, no cross-leak.
  let attempted = false

  return {
    name: "cache-control-subfield-rejection-retry",

    canHandle(error: ApiError): boolean {
      if (error.type !== "bad_request" || error.status !== 400 || attempted) return false
      return parseRejectedCacheControlSubfields(error) !== null
    },

    handle(error: ApiError, currentPayload: TPayload, _context: RetryContext<TPayload>): Promise<RetryAction<TPayload>> {
      attempted = true
      const fields = parseRejectedCacheControlSubfields(error)
      // canHandle guarantees non-null; defend defensively.
      if (fields === null) return Promise.resolve({ action: "abort", error })
      for (const field of fields) markAnthropicUnsupportedCacheControlSubfield(field)
      consola.warn(
        `[CacheControlSubfieldRejection] Upstream rejected cache_control subfield(s): ${fields.join(", ")}; stripping and retrying (learned endpoint-wide).`,
      )
      return Promise.resolve({
        action: "retry",
        payload: currentPayload,
        prepareHints: { excludeCacheControlSubfields: fields },
        meta: { strippedCacheControlSubfields: fields },
      })
    },
  }
}
