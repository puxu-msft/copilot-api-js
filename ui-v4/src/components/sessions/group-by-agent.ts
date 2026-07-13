import type { EntrySummary } from "@/types"

/** 一个 agent 的分组:lane 名(main / subagent <id前缀>)+ 该 agent 的请求条目。 */
export interface AgentLaneGroup {
  name: string
  entries: Array<EntrySummary>
}

/**
 * 按 agentId 把一个 session 的请求分组成 lane(spec §5):
 *  - **main lane** = `agentId === undefined` 的条目(main 请求 agent_id 为 NULL)。
 *  - 每个 **subagent** 一 lane,标签是不透明 agentId 前缀(无种类名),按首次出现顺序(Map 插入序)。
 *
 * 单一共享 primitive(drift 守卫):shadcn 侧 `SessionDetailShadcn` 从此导入,与 legacy
 * `SessionDetailLegacy` 内联的冻结副本保持同一语义;legacy 副本在 Z1 收尾删文件时一并退场。
 */
export function groupByAgent(entries: Array<EntrySummary>): Array<AgentLaneGroup> {
  const main: Array<EntrySummary> = []
  const subs = new Map<string, Array<EntrySummary>>()
  for (const e of entries) {
    if (e.agentId === undefined) main.push(e)
    else {
      const list = subs.get(e.agentId) ?? []
      list.push(e)
      subs.set(e.agentId, list)
    }
  }
  const lanes: Array<AgentLaneGroup> = []
  if (main.length > 0) lanes.push({ name: "main agent", entries: main })
  for (const [agentId, list] of subs) lanes.push({ name: `subagent ${agentId.slice(0, 10)}`, entries: list })
  return lanes
}
