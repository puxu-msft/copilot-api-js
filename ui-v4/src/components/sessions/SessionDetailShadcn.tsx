import {
  //
  Link,
  useParams,
} from "react-router-dom"

import { AgentLane } from "@/components/sessions/AgentLane"
import { groupByAgent } from "@/components/sessions/group-by-agent"
import { Card } from "@/components/ui/card"
import { useSessionEntries } from "@/hooks/useSessionEntries"

/**
 * fork B · Session 详情 shadcn 页元素(P5 完整版)。
 *
 * 与 legacy(`SessionDetailLegacy`)读**同一数据源**(`useSessionEntries`)+ 同一 `groupByAgent` 分组语义,
 * 仅呈现层不同:
 *  - 每个 agent 一组请求复用 **B 内容体 `AgentLane`**(C3 中性化,两树共用),逐字复用、零改动。
 *  - 页壳用 shadcn `Card` + 中性语义 token,返回列表是中性 `Link`(role=link)。
 * `data-testid=session-detail-shadcn` 供 fork B 互斥挂载守卫。
 */
export function SessionDetailShadcn() {
  const { id } = useParams()
  const { data, isLoading } = useSessionEntries(id)
  if (!id) return <div className="p-4 text-muted-foreground">no session</div>
  if (isLoading) return <div className="p-4 text-muted-foreground">loading…</div>
  const entries = (data?.entries ?? []).slice().sort((a, b) => a.startedAt - b.startedAt)
  const lanes = groupByAgent(entries)
  return (
    <div
      data-testid="session-detail-shadcn"
      className="flex flex-col gap-3 p-1 text-foreground"
    >
      <div className="flex items-center gap-3 text-sm">
        <Link
          to="/sessions"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          ‹ Sessions
        </Link>
        <span
          className="text-muted-foreground"
          title={id}
        >
          {id.slice(0, 16)}… · {entries.length} req · {lanes.length} lanes
        </span>
      </div>
      {lanes.length === 0 ?
        <div className="px-1 py-6 text-sm text-muted-foreground">No requests in this session.</div>
      : lanes.map((lane) => (
          <Card
            key={lane.name}
            className="overflow-hidden py-0"
          >
            {/* AgentLane(B)自带 lane 标题(名 + 摘要 + failed)+ 请求列表,逐字复用、零改动。 */}
            <AgentLane
              name={lane.name}
              entries={lane.entries}
            />
          </Card>
        ))
      }
    </div>
  )
}
