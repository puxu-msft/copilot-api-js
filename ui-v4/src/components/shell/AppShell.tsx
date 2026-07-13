import { useMemo } from "react"

import { LiveDock } from "@/components/requests/LiveDock"
import { DesignFork } from "@/components/shell/DesignFork"
import { LegacyChrome } from "@/components/shell/LegacyChrome"
import { ShadcnChrome } from "@/components/shell/shadcn/ShadcnChrome"
import { ShadcnLiveDock } from "@/components/shell/shadcn/ShadcnLiveDock"
import { useLiveRequests } from "@/hooks/useLiveRequests"
import { useWs } from "@/hooks/useWs"
import { useUiStore } from "@/stores/ui-store"

/**
 * AppShell = **常驻 L0**(round2-A1 结构隔离)。本组件体持有跨切换存活的一切:
 *  - `useWs`:WS 订阅(effect deps=[],挂载一次 acquire;socket 打开的**一次性 connected 快照**只派发给
 *    当时已注册的订阅者,故必须常驻)。
 *  - `useLiveRequests`:把在飞请求维护进常驻 live-store(晚挂载页面不再漏初始在途集,见 AppShellLiveSubscription)。
 *  - `<LiveDock/>` 挂载点(fork C 只 fork 呈现层,数据源不 fork)。
 *
 * **INV-FIDELITY-1(结构隔离强制)**:本组件体**源码零 `designVersion` 引用** —— 三 fork 点的
 * designVersion 读取全部下沉到 `<DesignFork/>` 原语(唯一读取者)。故切换 designVersion 绝无可能触发
 * L0 重渲染 / 重挂 WS 订阅 / 丢一次性 connected 快照。守卫见 AppShellForkStructure + DesignVersionForks。
 *
 * 三 fork 点(§5):A=shell chrome(NavRail/TopBar/布局 + `<Outlet/>`)、B=页元素(每 RoutePage 内部,
 * 逐页 plan)、C=LiveDock 呈现层。router 保持单树,fork 只在 L0 之下互斥挂载子树。
 */
export function AppShell() {
  const setWsConnected = useUiStore((s) => s.setWsConnected)
  const callbacks = useMemo(() => ({ onStatusChange: (c: boolean) => setWsConnected(c) }), [setWsConnected])
  useWs(callbacks)
  useLiveRequests()
  return (
    <>
      {/* fork A · chrome(含 `<Outlet/>` 布局):legacy vs shadcn 骨架互斥挂载。
          注:两版 chrome 是不同组件类型,切换会连同 `<Outlet/>` remount 当前被路由页 → 页级本地态
          (未保存表单 / 滚动位置 / 展开态)按设计重置(§5b 可接受);数据经 react-query 缓存 + live-store
          (均在 fork 之上/之外)无损存活。 */}
      <DesignFork
        legacy={<LegacyChrome />}
        shadcn={<ShadcnChrome />}
      />
      {/* fork C · LiveDock 呈现层:读同一常驻 live-store,切换不丢数据。挂载点常驻在 L0。 */}
      <DesignFork
        legacy={<LiveDock />}
        shadcn={<ShadcnLiveDock />}
      />
    </>
  )
}
