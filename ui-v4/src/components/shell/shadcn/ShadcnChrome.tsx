import { Outlet } from "react-router-dom"

import { ShadcnNavRail } from "@/components/shell/shadcn/ShadcnNavRail"
import { ShadcnTopBar } from "@/components/shell/shadcn/ShadcnTopBar"

/**
 * fork A · shadcn chrome 骨架。C6 只搭机制 + 最小骨架:加宽 NavRail(lucide 图标)+ TopBar
 * (含 designVersion 切换)+ main/Outlet。逐页页元素由 fork B 在各 RoutePage 内切,此处只提供外壳。
 * 中性语义 token(neutral preset),圆角随 `--radius`(C4 作用域化后 shadcn 树按 token 出圆角)。
 * `data-testid=chrome-shadcn` 供 INV-2 互斥挂载守卫。
 */
export function ShadcnChrome(): React.ReactElement {
  return (
    <div
      data-testid="chrome-shadcn"
      className="flex h-full bg-background text-foreground"
    >
      <ShadcnNavRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <ShadcnTopBar />
        {/* pb-14:给底部 fixed 浮岛(ShadcnLiveDock,同 legacy dock 尺寸)预留清空高度,
            使页面内容滚到底也不被浮岛遮住。与 LegacyChrome 对称(master 在 legacy 侧引入)。 */}
        <main className="min-h-0 flex-1 overflow-auto p-3 pb-14">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
