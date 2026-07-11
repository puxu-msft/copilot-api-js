import { useSessions } from "@/hooks/useSessions"

/**
 * fork B · Sessions shadcn 页元素(P5 骨架 → 后续子 commit 填成完整)。
 * `data-testid=sessions-shadcn` 供 fork B 互斥挂载守卫。中性语义 token(neutral surface)。
 */
export function SessionsShadcn() {
  const { isLoading } = useSessions()
  if (isLoading) return <div className="p-4 text-muted-foreground">loading…</div>
  return (
    <div
      data-testid="sessions-shadcn"
      className="p-1 text-foreground"
    />
  )
}
