/**
 * fork B · Models shadcn 页元素(P4 骨架)。RoutePage 经 `DesignFork` 在 shadcn 设计版本下互斥挂载本组件。
 * P4 后续子 commit 填成完整:shadcn 表格 + 详情**抽屉**(shadcn `Dialog` chrome 各自实现,内嵌 `HorizontalTabs`
 * 做 6 tab 横排替 legacy `ModelDetailSubRail` 竖排)。`data-testid=models-shadcn` 供 fork B 互斥挂载守卫。
 * 本文件零设计版本标识符(读取只在 RoutePage 的 `DesignFork`)。
 */
export function ModelsShadcn() {
  return (
    <div
      data-testid="models-shadcn"
      className="flex min-h-0 flex-1 flex-col p-4 text-foreground"
    >
      <div className="text-sm text-muted-foreground">Models(shadcn)…</div>
    </div>
  )
}
