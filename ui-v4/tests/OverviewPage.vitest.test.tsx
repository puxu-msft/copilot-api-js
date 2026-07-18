import {
  //
  act,
  render,
  screen,
} from "@testing-library/react"
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

// 稳定 status 快照(两 fork 都读 useStatus);含 legacy/shadcn 对齐的健康指标 + 深度字段(version/uptime/models)。
vi.mock("@/hooks/useStatus", () => ({
  useStatus: () => ({
    data: {
      status: "ok",
      version: "9.9.9",
      uptime: 3661,
      activeRequests: { count: 2 },
      rateLimiter: { enabled: true, mode: "normal" },
      quota: { status: "ok" },
      memory: { historyEntryCount: 42, inFlightCount: 1, historyBackend: "sqlite" },
      models: { totalCount: 80, availableCount: 64 },
      upstream_ws: { enabled: false, active_connections: 0 },
      shutdown: { phase: "running" },
      transport: {
        configured: {
          tcpKeepaliveProbeDelayMs: 15_000,
          h2PingIntervalMs: null,
          sessionConnectTimeoutMs: 5_000,
          pooledConnectionIdleTimeoutMs: 300_000,
          softMaxUpstreamWsConnections: 32,
        },
        h2Sessions: [
          {
            origin: "https://api.githubcopilot.com",
            generation: 3,
            lifecycle: "active",
            activeStreamCount: 2,
            effectivePingIntervalMs: 20_000,
            effectiveKeepAliveMs: undefined,
          },
        ],
        h2Reconcile: { state: "idle", lastCompletedGeneration: 3, lastError: null },
        upstreamWsPool: [{ key: "conn-1", model: "gpt-5.5", state: "busy", generation: 1 }],
        runtimeCapability: { runtime: "bun", wsApplicationKeepalive: "unavailable" },
      },
    },
    isLoading: false,
  }),
}))

const { OverviewPage } = await import("@/components/overview/OverviewPage")
const { useUiStore } = await import("@/stores/ui-store")
const { useLiveStore } = await import("@/stores/live-store")

describe("OverviewPage · fork B (designVersion routes legacy vs shadcn)", () => {
  beforeEach(() => {
    useLiveStore.setState({ byId: {} })
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })
  afterEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))

  it("amber-legacy: mounts OverviewLegacy, not the shadcn tree", () => {
    render(<OverviewPage />)
    // legacy 渲染(健康指标可见),但 shadcn 页壳标记缺席(INV-2 互斥挂载)。
    expect(screen.getByText("In-flight")).toBeDefined()
    expect(screen.queryAllByTestId("overview-shadcn")).toHaveLength(0)
    expect(screen.getByText(/Grafana/)).toBeDefined()
    // Transport StatCard (D7 HIGH-7 minimal parity item).
    expect(screen.getByText("Transport")).toBeDefined()
    expect(screen.getByText("idle")).toBeDefined()
    expect(screen.getByText("h2 1 · ws 1")).toBeDefined()
  })

  it("shadcn: mounts complete OverviewShadcn with health metrics parity + deep sections", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    render(<OverviewPage />)

    // 唯一 shadcn 页壳标记(互斥挂载:legacy 分支为 0)。
    expect(screen.queryAllByTestId("overview-shadcn")).toHaveLength(1)

    // 健康指标与 legacy 齐平(7 项 StatCard 复用 B 内容体,含新增 Transport)。
    for (const label of ["In-flight", "Rate limiter", "Quota", "Active (server)", "History entries", "Upstream WS", "Transport"]) {
      expect(screen.getByText(label), `${label} card`).toBeDefined()
    }
    // 指标值(自 mock 快照)真的渲染,非空壳。
    expect(screen.getByText("normal")).toBeDefined() // rate limiter mode
    expect(screen.getByText("42")).toBeDefined() // history entries
    expect(screen.getByText("2")).toBeDefined() // active (server)

    // 深度服务信息段(richest-data-flow:呈现可得字段 version/uptime/models)。
    expect(screen.getByText("9.9.9")).toBeDefined() // version
    expect(screen.getByText(/64\s*\/\s*80/)).toBeDefined() // models available/total

    // Grafana 深度分析入口是**真链接**(指向 /metrics),非纯文字占位。
    const metricsLink = screen.getByRole("link", { name: /metrics/i })
    expect(metricsLink.getAttribute("href")).toBe("/metrics")

    // Transport diagnostics 深度 Card(D7 HIGH-7:只在 shadcn 侧落地深度视图)。
    expect(screen.getByTestId("transport-diagnostics-card")).toBeDefined()
    expect(screen.getByText("https://api.githubcopilot.com")).toBeDefined()
    expect(screen.getByText("gpt-5.5")).toBeDefined()
    expect(screen.getByText("active")).toBeDefined()
    expect(screen.getByText("busy")).toBeDefined()
    expect(screen.getByText("32")).toBeDefined()
  })
})
