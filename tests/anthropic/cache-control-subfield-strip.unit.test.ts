import { afterEach, describe, expect, test } from "bun:test"

import { prepareAnthropicRequest } from "~/lib/anthropic/client"
import {
  collectUnsupportedCacheControlSubfields,
  filterCacheControlSubfields,
} from "~/lib/anthropic/request-preparation"
import { restoreStateForTests, setStateForTests, snapshotStateForTests } from "~/lib/state"

const originalState = snapshotStateForTests()
afterEach(() => restoreStateForTests(originalState))

describe("collectUnsupportedCacheControlSubfields", () => {
  test("内置默认含 scope（无需 config）", () => {
    expect(collectUnsupportedCacheControlSubfields("claude-opus-4-8").has("scope")).toBe(true)
  })
  test("config 追加字段（per-model + 通配）", () => {
    setStateForTests({ stripCacheControlSubfields: { "*": ["foo"], "claude-opus-4-8": ["bar"] } })
    const s = collectUnsupportedCacheControlSubfields("claude-opus-4-8")
    expect([...s].sort()).toEqual(["bar", "foo", "scope"])
  })
  test("源④ hints 并入", () => {
    const s = collectUnsupportedCacheControlSubfields("claude-opus-4-8", ["baz"])
    expect(s.has("baz")).toBe(true)
  })
})

describe("filterCacheControlSubfields", () => {
  test("剥 scope、保 type+ttl、返回剥掉列表", () => {
    const wire = {
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h", scope: "global" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "m", cache_control: { type: "ephemeral", scope: "global" } }] }],
      tools: [],
    }
    const stripped = filterCacheControlSubfields(wire as never, new Set(["scope"]))
    expect(stripped).toEqual(["scope"])
    expect((wire.system[0] as { cache_control: unknown }).cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect((wire.messages[0].content[0] as { cache_control: unknown }).cache_control).toEqual({ type: "ephemeral" })
  })

  test("黑名单为空 → 完全不动 + 返回 []", () => {
    const wire = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", scope: "x" } }], messages: [], tools: [] }
    expect(filterCacheControlSubfields(wire as never, new Set())).toEqual([])
    expect((wire.system[0] as { cache_control: unknown }).cache_control).toEqual({ type: "ephemeral", scope: "x" })
  })

  test("畸形 {scope} 无 type：剥后 cc 失去 type → 删整个 cache_control（L2 兜底）", () => {
    const wire = { system: [{ type: "text", text: "s", cache_control: { scope: "global" } }], messages: [], tools: [] }
    filterCacheControlSubfields(wire as never, new Set(["scope"]))
    expect((wire.system[0] as { cache_control?: unknown }).cache_control).toBeUndefined()
  })
})

describe("passthrough 子字段过滤（集成）", () => {
  test("剥 scope、保留其余客户端断点（§1.1 实测形态）", () => {
    setStateForTests({ cacheControlMode: "passthrough", copilotToken: "t", vsCodeVersion: "1.100.0", accountType: "individual" })
    const prepared = prepareAnthropicRequest({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: [
        { type: "text", text: "sys0" },
        { type: "text", text: "sys1", cache_control: { type: "ephemeral", scope: "global" } as never },
        { type: "text", text: "sys2", cache_control: { type: "ephemeral" } as never },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const sys = prepared.wire.system as Array<{ cache_control?: unknown }>
    expect(sys[1].cache_control).toEqual({ type: "ephemeral" }) // scope 已剥
    expect(sys[2].cache_control).toEqual({ type: "ephemeral" }) // 不变
  })

  test("prepared 结果透出 strippedCacheControlSubfields", () => {
    setStateForTests({ cacheControlMode: "passthrough", copilotToken: "t", vsCodeVersion: "1.100.0", accountType: "individual" })
    const prepared = prepareAnthropicRequest({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", scope: "global" } as never }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    expect(prepared.strippedCacheControlSubfields).toEqual(["scope"])
  })
})
