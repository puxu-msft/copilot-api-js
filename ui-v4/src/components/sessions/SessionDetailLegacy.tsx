import {
  //
  Link,
  useParams,
} from "react-router-dom"

import type { EntrySummary } from "@/types"

import { AgentLane } from "@/components/sessions/AgentLane"
import { useSessionEntries } from "@/hooks/useSessionEntries"

function groupByAgent(entries: Array<EntrySummary>): Array<{ name: string; entries: Array<EntrySummary> }> {
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
  const lanes: Array<{ name: string; entries: Array<EntrySummary> }> = []
  if (main.length > 0) lanes.push({ name: "main agent", entries: main })
  for (const [agentId, list] of subs) lanes.push({ name: `subagent ${agentId.slice(0, 10)}`, entries: list })
  return lanes
}

/**
 * fork B · Session 详情页元素(legacy,Terminal Amber,P5 前逐字冻结)。
 * 原 `SessionDetailPage` body 逐字搬来,Z1 收尾才删。共用 B 内容体 `AgentLane`(C3 中性化)。
 */
export function SessionDetailLegacy() {
  const { id } = useParams()
  const { data, isLoading } = useSessionEntries(id)
  if (!id) return <div className="mono p-4 text-[#666]">no session</div>
  if (isLoading) return <div className="mono p-4 text-[#888]">loading…</div>
  const entries = (data?.entries ?? []).slice().sort((a, b) => a.startedAt - b.startedAt)
  const lanes = groupByAgent(entries)
  return (
    <div className="mono flex flex-col gap-2 p-2">
      <div className="flex items-center gap-2 text-[13px]">
        <Link
          to="/sessions"
          className="text-[var(--color-primary)]"
        >
          ‹ Sessions
        </Link>
        <span className="text-[var(--color-muted)]">
          {id.slice(0, 16)}… · {entries.length} req · {lanes.length} lanes
        </span>
      </div>
      <div className="text-[11px] text-[#666]">
        每个 agent 一组:表标题(名 · 计数 · token · failed)+ 请求列表;subagent 标签为不透明 agentId(无种类名,spec §5)
      </div>
      {lanes.map((lane) => (
        <AgentLane
          key={lane.name}
          name={lane.name}
          entries={lane.entries}
        />
      ))}
    </div>
  )
}
