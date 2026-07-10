import {
  //
  render,
  screen,
} from "@testing-library/react"
import {
  //
  MemoryRouter,
  Route,
  Routes,
} from "react-router-dom"
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { WsCallbacks } from "@/lib/ws-client"
import type { ConnectedInfo } from "@/types/ws"

// 隔离 AppShell 自身的订阅逻辑:桩掉重型子组件(NavRail/TopBar),捕获 WS 订阅回调。
vi.mock("@/components/shell/NavRail", () => ({ NavRail: () => null }))
vi.mock("@/components/shell/TopBar", () => ({ TopBar: () => null }))

const acquired: Array<WsCallbacks> = []
vi.mock("@/lib/ws-client", () => ({
  wsClient: {
    acquire: (cb: WsCallbacks) => {
      acquired.push(cb)
      return () => {}
    },
  },
}))

const { AppShell } = await import("@/components/shell/AppShell")
const { useLiveStore } = await import("@/stores/live-store")

describe("AppShell 全局在途订阅(连接快照不因页面挂载时机丢失)", () => {
  beforeEach(() => {
    acquired.length = 0
    useLiveStore.setState({ byId: {} })
  })
  afterEach(() => useLiveStore.setState({ byId: {} }))

  it("connected 快照经 AppShell 落地 live-store(订阅提升到常驻根,晚挂载页面不再漏初始在途集)", () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route
              index
              element={<div>home</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    const info: ConnectedInfo = {
      clientCount: 1,
      activeRequests: [{ id: "pre1", endpoint: "anthropic-messages", state: "streaming", startTime: 0 }] as ConnectedInfo["activeRequests"],
    }
    // 一次性 connected 事件派发给当前所有订阅者(模拟 socket 打开时的初始快照)。
    for (const cb of acquired) cb.onConnected?.(info)
    // 修复前:AppShell 不订阅在途请求 → byId 空(useLiveRequests 只在 requests 页、挂载太晚);修复后:已落地。
    expect(Object.keys(useLiveStore.getState().byId)).toContain("pre1")
  })

  it("LiveDock 全局挂在 AppShell:非 /requests 路由也渲染在途信息,tail/合入控件隐藏", () => {
    useLiveStore.setState({ byId: { r1: { id: "r1", endpoint: "anthropic-messages", state: "streaming", startTime: 0 } } })
    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route
              path="overview"
              element={<div>ov</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    // LiveDock 全局挂载(在 AppShell)+ 读 live-store → 非 requests 页也显示在途摘要。
    expect(screen.getByText(/1 in-flight/)).toBeTruthy()
    // tail 开关 / 待合入 CTA 是列表专属,别页隐藏。
    expect(screen.queryByText(/▶ live|⏸ paused|待合入/)).toBeNull()
  })
})
