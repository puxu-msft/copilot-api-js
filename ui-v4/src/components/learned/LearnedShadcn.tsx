/**
 * fork B · Learned 页元素(shadcn 页壳,P7 骨架 —— 后续 commit 填成完整)。
 * `data-testid=learned-shadcn` 供 fork B 互斥挂载守卫。
 */
export function LearnedShadcn() {
  return (
    <div
      data-testid="learned-shadcn"
      className="flex h-full flex-col p-1 text-foreground"
    >
      <div className="p-4 text-sm text-muted-foreground">learned (shadcn skeleton)</div>
    </div>
  )
}
