import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"

import { applyInboundSystemPrompt } from "~/lib/system-prompt/inbound"

import { autoRestoreState } from "../helpers/state-fixture"

// processAnthropicSystem consults mutable config-backed state. Restore it after
// each test even when this file itself does not mutate it, so a preceding
// bucket-mate cannot leak a hot-reload value into later tests.
autoRestoreState()

// 最小 fake env：只实现分发函数触达的 clientFormat/body/with。
function fakeEnv(clientFormat: string, body: unknown): RequestEnvelope {
  const env = {
    request: { clientFormat: clientFormat } as RequestEnvelope["request"],
    attempt: { body: body } as RequestEnvelope["attempt"],
    candidate: {} as RequestEnvelope["candidate"],
    createView: () => ({}) as RequestEnvelope["view"],
  }
  return env as unknown as RequestEnvelope
}

describe("applyInboundSystemPrompt", () => {
  test("anthropic：无 system 时 early-return 原 env（不改 body 引用）", async () => {
    const env = fakeEnv("anthropic", { model: "m", messages: [] })
    const out = await applyInboundSystemPrompt(env)
    expect(out.attempt.body).toBe(env.attempt.body) // 同引用 = 未改
  })

  test("gemini：passthrough 返回原 env（不经 env 层分发）", async () => {
    const env = fakeEnv("gemini", { model: "m", contents: [] })
    const out = await applyInboundSystemPrompt(env)
    expect(out).toBe(env)
  })

  test("anthropic：有 system 时经 processAnthropicSystem 注入到 system 字段", async () => {
    const env = fakeEnv("anthropic", { model: "m", system: "hi", messages: [] })
    // 取用调用前的引用：env 现在是可变的，调用后再读 env.attempt.body 拿到的已是新 body，比较就恒等了。守的不变量不变——body 是被整体替换、不是就地改。
    const before = env.attempt.body
    const out = await applyInboundSystemPrompt(env)
    expect(out.attempt.body).not.toBe(before)
    expect((out.attempt.body as { system?: unknown }).system).toBeDefined()
  })
})
