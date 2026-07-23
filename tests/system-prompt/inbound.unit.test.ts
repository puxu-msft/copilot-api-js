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
    clientFormat,
    body,
    with(patch: { body?: unknown }) {
      return fakeEnv(clientFormat, patch.body ?? body)
    },
  }
  return env as unknown as RequestEnvelope
}

describe("applyInboundSystemPrompt", () => {
  test("anthropic：无 system 时 early-return 原 env（不改 body 引用）", async () => {
    const env = fakeEnv("anthropic", { model: "m", messages: [] })
    const out = await applyInboundSystemPrompt(env)
    expect(out.body).toBe(env.body) // 同引用 = 未改
  })

  test("gemini：passthrough 返回原 env（不经 env 层分发）", async () => {
    const env = fakeEnv("gemini", { model: "m", contents: [] })
    const out = await applyInboundSystemPrompt(env)
    expect(out).toBe(env)
  })

  test("anthropic：有 system 时经 processAnthropicSystem 注入到 system 字段", async () => {
    const env = fakeEnv("anthropic", { model: "m", system: "hi", messages: [] })
    const out = await applyInboundSystemPrompt(env)
    // system 被处理（body 引用改变；system 字段仍存在）
    expect(out.body).not.toBe(env.body)
    expect((out.body as { system?: unknown }).system).toBeDefined()
  })
})
