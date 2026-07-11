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
        <main className="min-h-0 flex-1 overflow-auto p-2">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
