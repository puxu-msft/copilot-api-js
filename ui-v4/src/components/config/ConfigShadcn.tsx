/**
 * fork B · Config 页元素(shadcn 页壳,P6 骨架 → 完整由后续子 commit 填充)。
 * `data-testid=config-shadcn` 供 fork B 互斥挂载守卫。
 */
export function ConfigShadcn() {
  return (
    <div
      data-testid="config-shadcn"
      className="p-1 text-foreground"
    />
  )
}
