import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { ModelTranslation } from "~/lib/state-vocabulary"

import {
  //
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
} from "~/lib/state"

import {
  //
  captureTranslationConfigSnapshot,
  type TranslationConfigSnapshot,
} from "../../../src/lib/pipeline/semantic/config-snapshot"

const RULES_A: ModelTranslation = { "anthropic-messages": [{ match: "gpt-5.5@openai-responses", features: ["strip-thinking-signature"] }] }
const RULES_B: ModelTranslation = { "anthropic-messages": [{ match: "gpt-5.6@openai-responses" }] }

const baseline = snapshotStateForTests()

afterEach(() => {
  restoreStateForTests(baseline)
})

function capture(): TranslationConfigSnapshot {
  return captureTranslationConfigSnapshot()
}

describe("translation config snapshot — identity", () => {
  test("the same config generation produces the same id, a different one does not", () => {
    setStateForTests({ modelTranslation: structuredClone(RULES_A) })
    const first = capture()
    setStateForTests({ modelTranslation: structuredClone(RULES_A) })
    const sameContent = capture()
    setStateForTests({ modelTranslation: structuredClone(RULES_B) })
    const changed = capture()

    expect(first.snapshotId).toBe(sameContent.snapshotId)
    expect(changed.snapshotId).not.toBe(first.snapshotId)
  })

  test("carries the rules it was captured from", () => {
    setStateForTests({ modelTranslation: structuredClone(RULES_A) })

    expect(capture().modelTranslation["anthropic-messages"]?.[0]?.match).toBe("gpt-5.5@openai-responses")
  })
})

describe("translation config snapshot — a hot reload only reaches later requests", () => {
  test("a snapshot captured before the reload still reads the old rules", () => {
    setStateForTests({ modelTranslation: structuredClone(RULES_A) })
    const inFlight = capture()

    setStateForTests({ modelTranslation: structuredClone(RULES_B) })

    expect(inFlight.modelTranslation["anthropic-messages"]?.[0]?.match).toBe("gpt-5.5@openai-responses")
    expect(capture().modelTranslation["anthropic-messages"]?.[0]?.match).toBe("gpt-5.6@openai-responses")
  })

  test("the captured view is frozen, so nothing downstream can edit it into agreement", () => {
    setStateForTests({ modelTranslation: structuredClone(RULES_A) })
    const snapshot = capture()
    const rules = snapshot.modelTranslation["anthropic-messages"]

    expect(Object.isFrozen(rules)).toBe(true)
    expect(Object.isFrozen(rules?.[0])).toBe(true)
    expect(Object.isFrozen(rules?.[0]?.features)).toBe(true)
  })
})

/**
 * 「每个 codec 都把这个 snapshot 带到 leg 上」这条不变量的守卫**不在本文件**——它需要真跑四个 codec 的 parse，属跨模块集成，见 `./config-snapshot-carry.it.test.ts`。
 *
 * 本文件此前有一条读 codec 源码文本的守卫（先查 `with()` 里手抄了没有，后改查有没有自建 `function makeEnvelope(`）。独立评审构造出反例证明它只守住某一种拼写：本地 builder 换个名字就能绕过且类型正确。守卫追不上合法写法时应当把不变量搬到行为层，而不是继续给正则加分支。
 */

