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

describe("sanitize 收窄（新行为）", () => {
  test("保留客户端 ttl:1h（extended 未激活，不再误降 5m）", () => {
    setStateForTests({ cacheControlMode: "sanitize", copilotToken: "t", vsCodeVersion: "1.100.0", accountType: "individual" })
    const prepared = prepareAnthropicRequest(
      payloadWith([{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } as never }]),
    )
    const sys = prepared.wire.system as Array<{ cache_control?: unknown }>
    expect(sys[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  test("剥 scope 子字段、保留 ttl", () => {
    setStateForTests({ cacheControlMode: "sanitize", copilotToken: "t", vsCodeVersion: "1.100.0", accountType: "individual" })
    const prepared = prepareAnthropicRequest(
      payloadWith([{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h", scope: "global" } as never }]),
    )
    const sys = prepared.wire.system as Array<{ cache_control?: unknown }>
    expect(sys[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  test("C1 跨层：system=5m + messages=1h → messages 降到 5m（排序守卫）", () => {
    setStateForTests({ cacheControlMode: "sanitize", copilotToken: "t", vsCodeVersion: "1.100.0", accountType: "individual" })
    const prepared = prepareAnthropicRequest({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } as never }],
      messages: [{ role: "user", content: [{ type: "text", text: "m", cache_control: { type: "ephemeral", ttl: "1h" } as never }] }],
    })
    const sys = prepared.wire.system as Array<{ cache_control?: unknown }>
    const msg = (prepared.wire.messages as Array<{ content: Array<{ cache_control?: unknown }> }>)[0].content
    expect(sys[0].cache_control).toEqual({ type: "ephemeral" })
    expect(msg[0].cache_control).toEqual({ type: "ephemeral" }) // 被降到 ≤system
  })
})

