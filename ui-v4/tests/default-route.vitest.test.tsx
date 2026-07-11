import {
  //
  render,
  screen,
} from "@testing-library/react"
import {
  //
  createMemoryRouter,
  RouterProvider,
} from "react-router-dom"
import {
  //
  describe,
  expect,
  it,
  vi,
} from "vitest"

// AppShell L0 挂载即建立 WS 订阅(useWs / useLiveRequests)——mock ws-client 使其在 jsdom 下无害。
vi.mock("@/lib/ws-client", () => ({
  wsClient: { acquire: () => () => {} },
}))
// Overview(legacy + shadcn 两支都读)依赖 useStatus;mock 成稳定快照,渲染不依赖网络。
vi.mock("@/hooks/useStatus", () => ({
  useStatus: () => ({
    data: {
      activeRequests: { count: 0 },
      rateLimiter: { enabled: false },
      quota: { status: "ok" },
      memory: { historyEntryCount: 7 },
      upstream_ws: { enabled: false },
    },
    isLoading: false,
  }),
}))

const { routes } = await import("@/App")

describe("default route (decision 6: / → /overview)", () => {
  it("index route redirects to Overview, not Requests", () => {
    // 确定性:memory router 从 "/" 起,index route 的 <Navigate replace/> 应落到 /overview。
    const router = createMemoryRouter(routes, { initialEntries: ["/"] })
    render(<RouterProvider router={router} />)
    // Overview 独有标记(两 fork 都含 Grafana 深度分析入口),Requests 页无 → 证 index 落 Overview。
    expect(screen.getByText(/Grafana/)).toBeDefined()
    expect(router.state.location.pathname).toBe("/overview")
  })
})
