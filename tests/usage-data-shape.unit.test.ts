import { expect, test } from "bun:test"

import type { ResponseData } from "~/lib/context/request"
import type { UsageData } from "~/lib/history/types"

// 编译期锁步守卫（复审 C1）：UsageData（history/types.ts）与 ResponseData.usage
// 内联（context/types.ts）是 usage 的两个拥有点，必须始终可互相赋值。若二者漂移
// （如一处 reasoning_tokens 必填、一处可选），此文件 typecheck 直接报错 —— 这正是
// 该守卫的目的：把「两处锁步」从口头约定变成编译期不变量。
test("UsageData and ResponseData.usage stay mutually assignable", () => {
  const u: UsageData = {
    input_tokens: 1,
    output_tokens: 2,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 4,
    input_tokens_details: { text: 1, audio: 2, image: 3, video: 4 },
    output_tokens_details: { reasoning_tokens: 5, text: 6, accepted_prediction_tokens: 7, rejected_prediction_tokens: 8 },
  }
  const r: ResponseData["usage"] = u
  const back: UsageData = r
  expect(back.cache_creation_input_tokens).toBe(4)
  expect(back.input_tokens_details?.image).toBe(3)
  expect(back.output_tokens_details?.accepted_prediction_tokens).toBe(7)
  expect(back.output_tokens_details?.reasoning_tokens).toBe(5)
})
