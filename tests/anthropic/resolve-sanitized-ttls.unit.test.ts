import { describe, expect, test } from "bun:test"

import { collectPerLayerClientTtls, resolveSanitizedTtls } from "~/lib/anthropic/request-preparation"

const ext = { toolsSystem: "1h" as const, messages: "5m" as const }

describe("resolveSanitizedTtls（仅规范化已有断点，不注入缺层）", () => {
  test("三层都有断点、合法递减 → 原样保留（extended 未激活）", () => {
    expect(resolveSanitizedTtls({ tools: "1h", system: "5m", messages: "5m" }, false, ext)).toEqual({
      tools: "1h",
      system: "5m",
      messages: "5m",
    })
  })

  test("C1 非法组合：system=5m + messages=1h → messages 降到 ≤system；tools 无断点不产生", () => {
    expect(resolveSanitizedTtls({ system: "5m", messages: "1h" }, false, ext)).toEqual({
      tools: undefined,
      system: "5m",
      messages: "5m",
    })
  })

  test("无任何断点 → 全 undefined（sanitize 不注入）", () => {
    expect(resolveSanitizedTtls({}, false, ext)).toEqual({ tools: undefined, system: undefined, messages: undefined })
  })

  test("extended 激活：只抬升已有断点的 floor（无断点层仍 undefined）", () => {
    // 只有 system 有断点，floorTS=1h → system 抬到 1h；tools/messages 无断点不产生
    expect(resolveSanitizedTtls({ system: "5m" }, true, ext)).toEqual({
      tools: undefined,
      system: "1h",
      messages: undefined,
    })
  })

  test("extended 激活 + system=5m + messages=1h → system 抬到 1h、messages 保 1h（递减成立）", () => {
    expect(resolveSanitizedTtls({ system: "5m", messages: "1h" }, true, ext)).toEqual({
      tools: undefined,
      system: "1h",
      messages: "1h",
    })
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
