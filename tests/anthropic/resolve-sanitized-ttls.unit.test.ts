import { describe, expect, test } from "bun:test"

import { collectPerLayerClientTtls, resolveSanitizedTtls } from "~/lib/anthropic/request-preparation"

const ext = { toolsSystem: "1h" as const, messages: "5m" as const }

describe("resolveSanitizedTtls", () => {
  test("合法递减原样保留（extended 未激活）", () => {
    expect(resolveSanitizedTtls({ tools: "1h", system: "5m", messages: "5m" }, false, ext)).toEqual({
      tools: "1h",
      system: "5m",
      messages: "5m",
    })
  })

  test("C1 非法组合：system=5m + messages=1h → messages 被降到 ≤system", () => {
    expect(resolveSanitizedTtls({ system: "5m", messages: "1h" }, false, ext)).toEqual({
      tools: "5m",
      system: "5m",
      messages: "5m",
    })
  })

  test("缺层默认 5m", () => {
    expect(resolveSanitizedTtls({}, false, ext)).toEqual({ tools: "5m", system: "5m", messages: "5m" })
  })

  test("extended 激活：floor 升级 + 仍满足递减", () => {
    // tools/system floor=1h, messages floor=5m；客户端全缺
    expect(resolveSanitizedTtls({}, true, ext)).toEqual({ tools: "1h", system: "1h", messages: "5m" })
  })

  test("extended 激活 + 客户端 messages=1h → messages 可保 1h（递减成立）", () => {
    expect(resolveSanitizedTtls({ messages: "1h" }, true, ext)).toEqual({ tools: "1h", system: "1h", messages: "1h" })
  })
})

describe("collectPerLayerClientTtls", () => {
  test("每层取该层出现的最大 ttl", () => {
    const wire = {
      system: [
        { type: "text", text: "a", cache_control: { type: "ephemeral" } },
        { type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }],
      tools: [],
    }
    expect(collectPerLayerClientTtls(wire)).toEqual({ tools: undefined, system: "1h", messages: "5m" })
  })
})
