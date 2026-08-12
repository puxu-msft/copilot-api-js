/**
 * 每个 codec 的 `parse` 是否真的把 ingress 钉定的 `translationConfigSnapshot` 带到了 leg 上。
 *
 * 取代 2026-08-11 之前那条读源码文本的守卫（它先查 `with()` 里有没有手抄字段，后改查「有没有 import 共享 `makeEnvelope`、有没有自建 `function makeEnvelope(`」）。**那一族守卫全都只守住某一种拼写**：独立评审构造出反例——把某个 codec 改成调用本地的 `buildEnvelope` 并在其中丢掉 `request.translationConfigSnapshot`，类型正确、守卫全绿、缺陷穿过去了。守卫追不上合法写法时该搬家，不该继续补模式。
 *
 * 所以这里改成行为 oracle：真跑四个 codec 的 `parse`，断言产出的 envelope 上就是**传进去的那个对象**，并且随后的热重载动不了它。这条对 envelope 是怎么造出来的完全无感——不论 builder 叫什么、在哪、有几个。
 *
 * 四条路径逐个列出而非 glob：第五个 codec 必须在这里红一次、被有意识地加进来，而不是被一个从没匹配过它的 glob 悄悄放行。
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RawHttpRequest } from "~/lib/pipeline/types"
import type { ModelTranslation } from "~/lib/state-vocabulary"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { createGeminiCodec } from "~/lib/codec/gemini/codec"
import { createOpenAiCcCodec } from "~/lib/codec/openai-cc/codec"
import { createOpenAiResponsesCodec } from "~/lib/codec/openai-responses/codec"
import { setModels } from "~/lib/models/cache"
import { ENDPOINT } from "~/lib/models/endpoint"
import { captureTranslationConfigSnapshot } from "~/lib/pipeline/semantic/config-snapshot"
import { setStateForTests } from "~/lib/state"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"

useIsolatedRuntime()

const NO_PREPROCESS = { strippedReadTagCount: 0, dedupedToolCallCount: 0 }
const RULES_A: ModelTranslation = { "anthropic-messages": [{ match: "a@openai-responses" }] }
const RULES_B: ModelTranslation = { "anthropic-messages": [{ match: "b@openai-responses" }] }

function raw(body: unknown, path: string, over?: Partial<RawHttpRequest>): RawHttpRequest {
  return { body, headers: new Headers({ "content-length": "42" }), method: "POST", path, ...over } as RawHttpRequest
}

function registerModels(): void {
  setModels({
    object: "list",
    data: [
      mockModel("claude-x", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES] }),
      mockModel("gpt-x", { vendor: "OpenAI", supported_endpoints: [ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES] }),
      mockModel("gemini-x", { vendor: "Google", supported_endpoints: [ENDPOINT.CHAT_COMPLETIONS] }),
    ],
  })
}

/** name → 用该 snapshot 跑一次真实 parse，返回落在 envelope 上的那个值。 */
const PARSERS: Record<string, (snapshot: ReturnType<typeof captureTranslationConfigSnapshot>) => unknown> = {
  anthropic: (translationConfigSnapshot) =>
    createAnthropicCodec({ betaProbe: createBetaProbe(undefined), preprocessInfo: NO_PREPROCESS, translationConfigSnapshot }).parse(
      raw({ model: "claude-x", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }, "/v1/messages"),
    ).request.translationConfigSnapshot,

  "openai-cc": (translationConfigSnapshot) =>
    createOpenAiCcCodec({ translationConfigSnapshot }).parse(raw({ model: "gpt-x", messages: [{ role: "user", content: "hi" }] }, "/chat/completions")).request
      .translationConfigSnapshot,

  "openai-responses": (translationConfigSnapshot) =>
    createOpenAiResponsesCodec({ translationConfigSnapshot }).parse(raw({ model: "gpt-x", input: "hi" }, "/responses")).request.translationConfigSnapshot,

  gemini: (translationConfigSnapshot) =>
    createGeminiCodec("gemini-x", { translationConfigSnapshot }).parse(
      raw({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }, "/v1beta/models/gemini-x:generateContent", {
        preResolved: { name: "gemini-x", model: mockModel("gemini-x", { vendor: "Google", supported_endpoints: [ENDPOINT.CHAT_COMPLETIONS] }) },
      } as Partial<RawHttpRequest>),
    ).request.translationConfigSnapshot,
}

describe("每个 codec 的 parse 都把 ingress 钉定的 translation config 带到 leg 上", () => {
  for (const [name, parse] of Object.entries(PARSERS)) {
    test(`${name} 把传入的那个 snapshot 原样放上 envelope`, () => {
      registerModels()
      setStateForTests({ modelTranslation: structuredClone(RULES_A) })
      const snapshot = captureTranslationConfigSnapshot()

      // 身份相等，不是内容相等：内容相等挡不住「某条腿自己重新 capture 了一次」——那正是热重载落在请求中途时会分叉的形态。
      expect(parse(snapshot)).toBe(snapshot)
    })

    test(`${name} 的 leg 不受 parse 之后的热重载影响`, () => {
      registerModels()
      setStateForTests({ modelTranslation: structuredClone(RULES_A) })
      const snapshot = captureTranslationConfigSnapshot()
      const carried = parse(snapshot)

      setStateForTests({ modelTranslation: structuredClone(RULES_B) })

      expect(carried).toBe(snapshot)
      expect(captureTranslationConfigSnapshot().snapshotId).not.toBe(snapshot.snapshotId)
    })
  }
})
