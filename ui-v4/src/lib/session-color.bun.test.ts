import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  computeSessionRuns,
  DEFAULT_PALETTE_NAME,
  SESSION_PALETTES,
  sessionColor,
  sessionTint,
} from "@/lib/session-color"

const SEMANTIC = ["#d4a04a", "#7fd99a", "#e08a8a"] // primary/warn, ok, fail
const P = SESSION_PALETTES.find((p) => p.name === DEFAULT_PALETTE_NAME)!

describe("SESSION_PALETTES 注册表", () => {
  test("默认色板在注册表内", () => {
    expect(P).toBeDefined()
    expect(SESSION_PALETTES.length).toBeGreaterThanOrEqual(4)
  })
  test("每色是合法 6 位 hex、shade 较 base 更深", () => {
    const hex = /^#[0-9a-f]{6}$/
    for (const pal of SESSION_PALETTES) {
      expect(pal.colors.length).toBeGreaterThanOrEqual(8)
      for (const { base, shade } of pal.colors) {
        expect(base).toMatch(hex)
        expect(shade).toMatch(hex)
        // shade 明度更低：sRGB 亮度近似 (r+g+b) 之和更小
        const sum = (h: string) => Number.parseInt(h.slice(1, 3), 16) + Number.parseInt(h.slice(3, 5), 16) + Number.parseInt(h.slice(5, 7), 16)
        expect(sum(shade)).toBeLessThan(sum(base))
      }
    }
  })
  test("无 base/shade 撞语义信号色", () => {
    for (const pal of SESSION_PALETTES) {
      for (const { base, shade } of pal.colors) {
        expect(SEMANTIC).not.toContain(base)
        expect(SEMANTIC).not.toContain(shade)
      }
    }
  })
  test("alpha 档位：0<faint<strong<=1", () => {
    for (const pal of SESSION_PALETTES) {
      expect(pal.faintAlpha).toBeGreaterThan(0)
      expect(pal.faintAlpha).toBeLessThan(pal.strongAlpha)
      expect(pal.strongAlpha).toBeLessThanOrEqual(1)
    }
  })
})

describe("sessionColor", () => {
  test("undefined → null", () => {
    expect(sessionColor(undefined, P)).toBeNull()
    expect(sessionColor("", P)).toBeNull()
  })
  test("同 id 稳定同色", () => {
    expect(sessionColor("sess-abc", P)).toEqual(sessionColor("sess-abc", P))
  })
  test("不同 id 抽样落多个槽", () => {
    const idxs = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(sessionColor(`s${i}`, P))))
    expect(idxs.size).toBeGreaterThan(3)
  })
})

describe("sessionTint", () => {
  test("hex → rgba", () => {
    expect(sessionTint("#2f9af2", 0.14)).toBe("rgba(47, 154, 242, 0.14)")
  })
})

describe("computeSessionRuns", () => {
  const rows = [
    { id: "a", sessionId: "S1", agentId: undefined },
    { id: "b", sessionId: "S1", agentId: "ag1" }, // subagent
    { id: "c", sessionId: "S2", agentId: undefined }, // 打断 S1
    { id: "d", sessionId: "S1", agentId: undefined }, // S1 第二段
    { id: "e", sessionId: undefined, agentId: undefined }, // 无会话
  ]
  const runs = computeSessionRuns(rows, P)

  test("无 sessionId 行不入 map", () => {
    expect(runs.has("e")).toBe(false)
  })
  test("段首/段尾边界正确（S1 被 S2 打断成两段）", () => {
    expect(runs.get("a")!.isRunStart).toBe(true)
    expect(runs.get("b")!.isRunEnd).toBe(true) // 下一行 c 是 S2
    expect(runs.get("d")!.isRunStart).toBe(true) // 上一行 c 是 S2
    expect(runs.get("d")!.isRunEnd).toBe(true) // 下一行 e 非 S1
  })
  test("subagent 行 indent=true 且色带用 shade", () => {
    expect(runs.get("b")!.indent).toBe(true)
    expect(runs.get("b")!.shade).not.toBe(runs.get("b")!.color)
    expect(runs.get("a")!.indent).toBe(false)
  })
  test("同 id 的 a 与 d 同 color（同 S1）", () => {
    expect(runs.get("a")!.color).toBe(runs.get("d")!.color)
  })
  test("末行 isRunEnd=true（分页前沿暂定）", () => {
    const r2 = computeSessionRuns([{ id: "x", sessionId: "S9" }], P)
    expect(r2.get("x")!.isRunStart).toBe(true)
    expect(r2.get("x")!.isRunEnd).toBe(true)
  })
})
