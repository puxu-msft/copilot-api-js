/**
 * fork B · Requests 详情全屏页 shadcn 侧(P3 骨架 → 后续 commit 填成完整)。
 * `data-testid=request-detail-shadcn` 供 fork B 互斥挂载守卫。完整 chrome(返回列表 shadcn +
 * prev/next 相邻导航)+ `DetailPanelShadcn`(`HorizontalTabs` 水平 7 段替竖排 sub-rail)在后续 commit 填。
 * 本文件零设计版本标识符(读取只在 RoutePage 的 `DesignFork`)。
 */
export function RequestDetailShadcn() {
  return (
    <div
      data-testid="request-detail-shadcn"
      className="flex h-full min-h-0 flex-col text-foreground"
    />
  )
}
