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
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {/* pb-14:给底部 fixed 浮岛(LiveDock,bottom-3 + h-8 ≈ 44px 折叠占位)预留清空高度,
            使页面内容滚到底也不被浮岛遮住。展开面板是瞬时/用户触发的,不为它常驻预留(否则白占半屏)。 */}
        <main className="min-h-0 flex-1 overflow-auto p-2 pb-14">
          <Outlet />
        </main>
      </div>
      {/* 在途活动状态栏 = fixed 浮岛(自身定位到视口底部),脱离子布局、全局所有页面可见;
          放这里只为常驻挂载,fixed 定位不参与 flex 布局流。tail/待合入 控件在 LiveDock 内按 /requests 自门控。 */}
      <LiveDock />
    </div>
  )
}
