import { Outlet } from "react-router-dom"

import { NavRail } from "@/components/shell/NavRail"
import { TopBar } from "@/components/shell/TopBar"

/**
 * fork A · legacy chrome(Terminal Amber shell)。C6 前 AppShell 内联的布局原样搬来:
 * NavRail + TopBar + main/Outlet。放在 DesignFork 的 legacy 分支,与 shadcn chrome 互斥挂载。
 * `data-testid=chrome-legacy` 供 INV-2 互斥挂载守卫。
 */
export function LegacyChrome(): React.ReactElement {
  return (
    <div
      data-testid="chrome-legacy"
      className="flex h-full"
    >
      <NavRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {/* pb-14:给底部 fixed 浮岛(LiveDock,bottom-3 + h-8 ≈ 44px 折叠占位)预留清空高度,
            使页面内容滚到底也不被浮岛遮住。展开面板是瞬时/用户触发的,不为它常驻预留(否则白占半屏)。 */}
        <main className="min-h-0 flex-1 overflow-auto p-2 pb-14">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
