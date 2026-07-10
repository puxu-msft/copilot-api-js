import { useMemo } from "react"
import { Outlet } from "react-router-dom"

import { LiveDock } from "@/components/requests/LiveDock"
import { NavRail } from "@/components/shell/NavRail"
import { TopBar } from "@/components/shell/TopBar"
import { useLiveRequests } from "@/hooks/useLiveRequests"
import { useWs } from "@/hooks/useWs"
import { useUiStore } from "@/stores/ui-store"

export function AppShell() {
  const setWsConnected = useUiStore((s) => s.setWsConnected)
  const callbacks = useMemo(() => ({ onStatusChange: (c: boolean) => setWsConnected(c) }), [setWsConnected])
  useWs(callbacks)
  // 在途请求订阅提升到常驻根:socket 打开时的一次性 `connected` 快照(含打开前已在飞行的请求)只派发给
  // 当时已注册的订阅者。若只在 requests 页订阅,页面晚挂载(默认路由非 requests / 导航过去)会漏掉初始快照,
  // 表现为「只显示打开页面后的在途请求」。放在常驻的 AppShell 保证从应用启动即持续维护 live-store。
  // 见 AppShellLiveSubscription 回归测试。
  useLiveRequests()
  return (
    <div className="flex h-full">
      <NavRail />
      {/* relative:LiveDock 展开面板 `absolute bottom-6` 的定位锚。 */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-auto p-2">
          <Outlet />
        </main>
        {/* 在途活动状态栏提升为全局浮窗:所有页面都能看到在途请求信息(摘要 + 展开明细);
            tail 开关 / 待合入 CTA 是请求列表专属控件,LiveDock 内按路由(/requests)自门控。 */}
        <LiveDock />
      </div>
    </div>
  )
}
