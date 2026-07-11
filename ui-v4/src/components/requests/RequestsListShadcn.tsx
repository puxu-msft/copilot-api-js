/**
 * fork B · Requests 列表 shadcn 页元素(骨架,P2 commit 1 落 fork 机制;完整列表 + 列配置三态在后续 commit 填)。
 * 中性语义 token,`data-testid=requests-shadcn` 供 fork B 互斥挂载守卫。本文件零设计版本标识符
 * (设计版本读取只在 RoutePage 的 `DesignFork`)。
 */
export function RequestsListShadcn(): React.ReactElement {
  return (
    <div
      data-testid="requests-shadcn"
      className="flex h-full min-h-0 flex-col p-1 text-foreground"
    >
      <div className="text-sm text-muted-foreground">shadcn Requests(填充中)…</div>
    </div>
  )
}
