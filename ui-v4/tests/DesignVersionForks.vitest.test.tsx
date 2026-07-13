import {
  //
  act,
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

// 捕获 WS 订阅次数:remount L0 → cleanup + 再 acquire,acquired.length 会增长。这是「L0 未重挂」最强信号。
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
const { DesignFork } = await import("@/components/shell/DesignFork")
const { useUiStore } = await import("@/stores/ui-store")
const { useLiveStore } = await import("@/stores/live-store")

function renderShell() {
  return render(
    <MemoryRouter initialEntries={["/x"]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route
            path="x"
            element={<div>page</div>}
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe("DesignFork 原语 · INV-2 互斥挂载(绝不双挂)", () => {
  afterEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))

  it("amber-legacy 只挂 legacy 分支", () => {
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
    render(
      <DesignFork
        legacy={<div data-testid="leg" />}
        shadcn={<div data-testid="shad" />}
      />,
    )
    expect(screen.queryAllByTestId("leg")).toHaveLength(1)
    expect(screen.queryAllByTestId("shad")).toHaveLength(0)
  })

  it("shadcn 只挂 shadcn 分支", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    render(
      <DesignFork
        legacy={<div data-testid="leg" />}
        shadcn={<div data-testid="shad" />}
      />,
    )
    expect(screen.queryAllByTestId("leg")).toHaveLength(0)
    expect(screen.queryAllByTestId("shad")).toHaveLength(1)
  })
})

describe("AppShell 三 fork 点 · INV-2 互斥挂载", () => {
  beforeEach(() => {
    acquired.length = 0
    useLiveStore.setState({ byId: {} })
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })
  afterEach(() => {
    useLiveStore.setState({ byId: {} })
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })

  it("fork A(chrome):amber-legacy 只挂 legacy chrome,shadcn 只挂 shadcn chrome", () => {
    renderShell()
    expect(screen.queryAllByTestId("chrome-legacy")).toHaveLength(1)
    expect(screen.queryAllByTestId("chrome-shadcn")).toHaveLength(0)
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    expect(screen.queryAllByTestId("chrome-legacy")).toHaveLength(0)
    expect(screen.queryAllByTestId("chrome-shadcn")).toHaveLength(1)
  })

  it("fork C(LiveDock 呈现层):两版各挂一棵,绝不双挂", () => {
    renderShell()
    expect(screen.queryAllByTestId("dock-legacy")).toHaveLength(1)
    expect(screen.queryAllByTestId("dock-shadcn")).toHaveLength(0)
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    expect(screen.queryAllByTestId("dock-legacy")).toHaveLength(0)
    expect(screen.queryAllByTestId("dock-shadcn")).toHaveLength(1)
  })
})

describe("INV-FIDELITY-1 行为回归 · 切换 designVersion 绝不重挂 L0", () => {
  beforeEach(() => {
    acquired.length = 0
    useLiveStore.setState({ byId: {} })
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })
  afterEach(() => {
    useLiveStore.setState({ byId: {} })
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })

  it("connected 快照到达后切换 designVersion:WS 订阅未重 acquire + 在飞请求仍在 live-store", () => {
    renderShell()
    // L0 挂载即建立 WS 订阅。基线次数(AppShell 直接 useWs + useLiveRequests 内部 useWs = 2)——
    // 关键不变量不是「等于几」,而是**切换后不增长**(增长 = L0 重挂 → cleanup + 再 acquire)。
    const acquiredOnMount = acquired.length
    expect(acquiredOnMount).toBeGreaterThan(0)
    const info: ConnectedInfo = {
      clientCount: 1,
      activeRequests: [{ id: "pre1", endpoint: "anthropic-messages", state: "streaming", startTime: 0 }] as ConnectedInfo["activeRequests"],
    }
    // 一次性 connected 快照落地 live-store(经常驻 useLiveRequests)。
    act(() => {
      for (const cb of acquired) cb.onConnected?.(info)
    })
    expect(Object.keys(useLiveStore.getState().byId)).toContain("pre1")

    // 切换 designVersion(store 变更,非导航)。结构隔离:L0 本体不订阅 designVersion → 不重渲染 → 不重挂。
    act(() => useUiStore.getState().setDesignVersion("shadcn"))

    // ① WS 订阅未二次 acquire(L0 未重挂:acquire 次数不因切换增长)。
    expect(acquired).toHaveLength(acquiredOnMount)
    // ② 一次性 connected 快照仍在(未因切换丢失)。
    expect(Object.keys(useLiveStore.getState().byId)).toContain("pre1")
  })
})
