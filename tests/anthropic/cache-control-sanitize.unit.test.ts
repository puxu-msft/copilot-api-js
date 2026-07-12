import { afterEach, describe, expect, test } from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"

import { prepareAnthropicRequest } from "~/lib/anthropic/client"
import { restoreStateForTests, setStateForTests, snapshotStateForTests } from "~/lib/state"

const originalState = snapshotStateForTests()
afterEach(() => restoreStateForTests(originalState))

function payloadWith(system: MessagesPayload["system"]): MessagesPayload {
  return {
    model: "claude-opus-4-8",
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  }
}

describe("[GOLDEN] sanitize 现状（改动前基线）", () => {
  test("现状：sanitize 把客户端 ttl:1h 降为 5m（extended 未激活）", () => {
    setStateForTests({ cacheControlMode: "sanitize", copilotToken: "t", vsCodeVersion: "1.100.0", accountType: "individual" })
    const prepared = prepareAnthropicRequest(
      payloadWith([{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } as never }]),
    )
    const sys = prepared.wire.system as Array<{ cache_control?: unknown }>
    // 现状行为（本 test 锁定，Task 0.4 会改成保留 1h）：
    expect(sys[0].cache_control).toEqual({ type: "ephemeral" })
  })
})
