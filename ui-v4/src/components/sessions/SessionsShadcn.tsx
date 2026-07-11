import { SessionRow } from "@/components/sessions/SessionRow"
import {
  //
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useSessions } from "@/hooks/useSessions"

/**
 * fork B · Sessions 列表 shadcn 页元素(P5 完整版)。
 *
 * 与 legacy(`SessionsLegacy`)读**同一数据源**(`useSessions`),仅呈现层不同:
 *  - 会话行复用 **B 内容体 `SessionRow`**(C3 中性化,两树共用),富行聚合逐字复用、零改动。
 *  - 页壳用 shadcn `Card` + 中性语义 token(`text-foreground`/`text-muted-foreground`/`bg-card`),
 *    圆角随 `--radius`。
 * `data-testid=sessions-shadcn` 供 fork B 互斥挂载守卫。
 */
export function SessionsShadcn() {
  const { data, isLoading } = useSessions()
  if (isLoading) return <div className="p-4 text-muted-foreground">loading…</div>
  const sessions = data?.sessions ?? []
  return (
    <div
      data-testid="sessions-shadcn"
      className="p-1 text-foreground"
    >
      <Card>
        <CardHeader>
          <CardTitle>Sessions · {sessions.length}</CardTitle>
          <CardDescription>按会话聚合的请求(状态 · 起止 · token · 完成/失败 · 首末消息)。</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {sessions.length === 0 ?
            <div className="px-4 py-6 text-sm text-muted-foreground">No sessions recorded yet.</div>
          : <div className="flex flex-col">
              {sessions.map((s) => (
                <SessionRow
                  key={s.sessionId}
                  s={s}
                />
              ))}
            </div>
          }
        </CardContent>
      </Card>
    </div>
  )
}
