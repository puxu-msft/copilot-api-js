import {
  //
  describe,
  expect,
  it,
} from "vitest"

import type { EntrySummary } from "@/types"

import { groupByAgent } from "@/components/sessions/group-by-agent"

/**
 * `groupByAgent` 是 session 详情两树共用语义的**单一共享 primitive**(shadcn 从此导入;legacy 保留冻结
 * 内联副本到 Z1)。此单元测试是那条跨站点不变量的 drift 守卫——多 subagent lane 顺序、main-empty、空输入
 * 边界都在此钉死,而非仅靠 fork-routed 测试的单 fixture。
 */
const e = (over: Partial<EntrySummary>): EntrySummary =>
  ({ id: "x", startedAt: 0, endpoint: "anthropic-messages", messageCount: 0, previewText: "", responsePreviewText: "", ...over }) as EntrySummary

describe("groupByAgent", () => {
  it("puts undefined-agentId entries in the leading 'main agent' lane", () => {
    const lanes = groupByAgent([e({ id: "a" }), e({ id: "b" })])
    expect(lanes).toHaveLength(1)
    expect(lanes[0].name).toBe("main agent")
    expect(lanes[0].entries.map((x) => x.id)).toEqual(["a", "b"])
  })

  it("emits one lane per subagent in first-seen (insertion) order, after main", () => {
    const lanes = groupByAgent([
      e({ id: "m1" }),
      e({ id: "s2a", agentId: "agent-second-xyz" }),
      e({ id: "s1a", agentId: "agent-first-abc" }),
      e({ id: "s2b", agentId: "agent-second-xyz" }),
    ])
    // main first, then subagents in the order their agentId first appeared.
    expect(lanes.map((l) => l.name)).toEqual(["main agent", "subagent agent-seco", "subagent agent-firs"])
    // grouped entries preserve arrival order within a lane.
    expect(lanes[1].entries.map((x) => x.id)).toEqual(["s2a", "s2b"])
  })

  it("omits the main lane entirely when there are no main-agent entries", () => {
    const lanes = groupByAgent([e({ id: "s", agentId: "agent-only-sub" })])
    expect(lanes.map((l) => l.name)).toEqual(["subagent agent-only"])
  })

  it("returns no lanes for an empty entry list", () => {
    expect(groupByAgent([])).toEqual([])
  })
})
