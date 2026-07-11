import { useParams } from "react-router-dom"

import { useSessionEntries } from "@/hooks/useSessionEntries"

/**
 * fork B · Session 详情 shadcn 页元素(P5 骨架 → 后续子 commit 填成完整)。
 * `data-testid=session-detail-shadcn` 供 fork B 互斥挂载守卫。中性语义 token(neutral surface)。
 */
export function SessionDetailShadcn() {
  const { id } = useParams()
  const { isLoading } = useSessionEntries(id)
  if (!id) return <div className="p-4 text-muted-foreground">no session</div>
  if (isLoading) return <div className="p-4 text-muted-foreground">loading…</div>
  return (
    <div
      data-testid="session-detail-shadcn"
      className="p-1 text-foreground"
    />
  )
}
