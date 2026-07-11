import type { ReactNode } from "react"

import { useUiStore } from "@/stores/ui-store"

/**
 * 双树切换的**唯一 fork 原语**(C6,round2-A1「结构隔离 > 纪律」)。
 *
 * 这是全应用**除 `stores/ui-store`(拥有方)与 `lib/data-design`(DOM 属性反射)外**唯一读取
 * `store.designVersion` 的组件。chrome / LiveDock 呈现层 / 逐页页壳一律通过 `<DesignFork legacy shadcn/>`
 * 互斥挂载两棵子树,自身**不出现 `designVersion` 标识符** —— 由此:
 *  - 持 `useWs`/`useLiveRequests` 的 AppShell L0 本体天然零 `designVersion`(INV-FIDELITY-1 结构强制:
 *    切换绝不触发 L0 重渲染 / 重挂 WS 订阅 / 丢一次性 connected 快照)。
 *  - B/A′ 域的页壳文件天然不出现 `designVersion`(Global Constraint 5 grep 守卫零命中)。
 *
 * INV-2(互斥挂载):三元只渲染一支,绝不双挂。切换是 store 变更(非导航)→ URL/route 不变 →
 * react-router 保持同一路由 → 此原语重渲染切分支 → legacy 子树卸载、shadcn 子树挂载。
 */
export function DesignFork({ legacy, shadcn }: { legacy: ReactNode; shadcn: ReactNode }): ReactNode {
  const designVersion = useUiStore((s) => s.designVersion)
  return designVersion === "shadcn" ? shadcn : legacy
}
