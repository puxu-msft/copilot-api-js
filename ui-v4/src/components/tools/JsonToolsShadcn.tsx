/**
 * fork B · JSON decode 工具页元素(shadcn 页壳,P8 骨架 → 后续子 commit 填成完整)。
 * `data-testid=json-tools-shadcn` 供 fork B 互斥挂载守卫。
 */
export function JsonToolsShadcn() {
  return (
    <div
      data-testid="json-tools-shadcn"
      className="flex h-full flex-col gap-2 p-2 text-foreground"
    >
      <div className="p-4 text-sm text-muted-foreground">JSON tools (shadcn) — 骨架</div>
    </div>
  )
}
