import { OverviewLegacy } from "@/components/overview/OverviewLegacy"
import { OverviewShadcn } from "@/components/overview/OverviewShadcn"
import { DesignFork } from "@/components/shell/DesignFork"

/**
 * fork B 示范页壳(C6)。RoutePage 通过 `DesignFork` 原语按设计版本(design version)互斥挂载 legacy/shadcn
 * 页元素。本文件不含 store 字段标识符(唯一读取者是 DesignFork)→ overview/ 域 grep 守卫零命中。
 * 逐页内容(shadcn 侧)打磨留后续 per-page plan;C6 只落 fork B 机制 + 一个示范。
 */
export function OverviewPage() {
  return (
    <DesignFork
      legacy={<OverviewLegacy />}
      shadcn={<OverviewShadcn />}
    />
  )
}
