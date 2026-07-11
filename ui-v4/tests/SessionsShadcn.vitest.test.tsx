/**
 * Sessions fork-routed 测试(P5 §8.2)——渲染真实 `SessionsPage` / `SessionDetailPage`(DesignFork),
 * 由 `designVersion` 决定挂 legacy(Terminal Amber 页元素)vs shadcn(重设计页壳)。
 * shadcn 分支断言:互斥挂载(`sessions-shadcn` / `session-detail-shadcn` 唯一)+ 复用 B 内容体
 * (`SessionRow` 富行 / `AgentLane` lane)逐字呈现 + 空态 + 计数/分组信息。amber-legacy 分支断 legacy
 * 内容仍在、shadcn 标记缺席(INV-2 互斥挂载)。
 */
import {
  //
  act,
  fireEvent,
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

// drivable mocks(vi.hoisted 使 fn 在 hoisted vi.mock factory 前存在)——多数用默认数据,
// 空态测试覆写为空列表。
const { mockUseSessions, mockUseSessionEntries } = vi.hoisted(() => ({
  mockUseSessions: vi.fn(),
  mockUseSessionEntries: vi.fn(),
}))

vi.mock("@/hooks/useSessions", () => ({ useSessions: () => mockUseSessions() }))
vi.mock("@/hooks/useSessionEntries", () => ({ useSessionEntries: () => mockUseSessionEntries() }))

const DEFAULT_SESSIONS = {
  data: {
    sessions: [
      {
        sessionId: "a3f1aaaaaaaa9c2",
        requestCount: 34,
        agentCount: 4,
        inputTokens: 1000,
        outputTokens: 500,
        firstStartedAt: 0,
        lastStartedAt: 720000,
        completed: 33,
        failed: 1,
        aborted: 0,
        models: ["opus"],
        firstPreview: "hello",
        preview: "bye",
      },
    ],
  },
  isLoading: false,
}

const DEFAULT_ENTRIES = {
  data: {
    entries: [
      { id: "r1", startedAt: 1, state: "completed", endpoint: "anthropic-messages", messageCount: 0, previewText: "" },
      { id: "r2", agentId: "agent-explore-xyz", startedAt: 2, state: "completed", endpoint: "anthropic-messages", messageCount: 0, previewText: "" },
      { id: "r3", agentId: "agent-explore-xyz", startedAt: 3, state: "failed", endpoint: "anthropic-messages", messageCount: 0, previewText: "" },
    ],
    total: 3,
  },
  isLoading: false,
}

const { SessionsPage } = await import("@/components/sessions/SessionsPage")
const { SessionDetailPage } = await import("@/components/sessions/SessionDetailPage")
const { useUiStore } = await import("@/stores/ui-store")

function renderSessions() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <Routes>
        <Route
          path="/sessions"
          element={<SessionsPage />}
        />
        <Route
          path="/sessions/:id"
          element={<div>detail-page</div>}
        />
      </Routes>
    </MemoryRouter>,
  )
}

function renderDetail(path = "/sessions/sess-1") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/sessions/:id"
          element={<SessionDetailPage />}
        />
        <Route
          path="/sessions"
          element={<div>sessions-list</div>}
        />
        <Route
          path="/requests/:id"
          element={<div>request-detail</div>}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe("SessionsPage · fork B (designVersion routes legacy vs shadcn)", () => {
  beforeEach(() => {
    mockUseSessions.mockReturnValue(DEFAULT_SESSIONS)
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })
  afterEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))

  it("amber-legacy: mounts SessionsLegacy (no shadcn marker); rows visible", () => {
    renderSessions()
    expect(screen.queryAllByTestId("sessions-shadcn")).toHaveLength(0)
    expect(screen.getByText(/34 req/)).toBeDefined()
    expect(screen.getByText(/Sessions · 1/)).toBeDefined()
  })

  it("shadcn: mounts SessionsShadcn exclusively + reuses SessionRow (B) rows verbatim", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderSessions()
    expect(screen.queryAllByTestId("sessions-shadcn")).toHaveLength(1)
    // 复用 B 内容体 SessionRow:富行聚合可见。
    expect(screen.getByText(/34 req/)).toBeDefined()
    expect(screen.getByText(/main\+4/)).toBeDefined()
    expect(screen.getByText(/✓33/)).toBeDefined()
    expect(screen.getByText(/Sessions · 1/)).toBeDefined()
    // 行点击导航(SessionRow 的 navigate 行为透传)。
    fireEvent.click(screen.getByText(/34 req/))
    expect(screen.getByText("detail-page")).toBeDefined()
  })

  it("shadcn: renders an empty state when the session list is empty", () => {
    mockUseSessions.mockReturnValue({ data: { sessions: [] }, isLoading: false })
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderSessions()
    expect(screen.queryAllByTestId("sessions-shadcn")).toHaveLength(1)
    expect(screen.getByText(/no sessions/i)).toBeDefined()
  })
})

describe("SessionDetailPage · fork B (designVersion routes legacy vs shadcn)", () => {
  beforeEach(() => {
    mockUseSessionEntries.mockReturnValue(DEFAULT_ENTRIES)
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })
  afterEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))

  it("amber-legacy: mounts SessionDetailLegacy (no shadcn marker); lanes visible", () => {
    renderDetail()
    expect(screen.queryAllByTestId("session-detail-shadcn")).toHaveLength(0)
    expect(screen.getByText(/main agent/)).toBeDefined()
    expect(screen.getByText(/3 req · 2 lanes/)).toBeDefined()
  })

  it("shadcn: mounts SessionDetailShadcn exclusively + reuses AgentLane (B) lanes verbatim", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderDetail()
    expect(screen.queryAllByTestId("session-detail-shadcn")).toHaveLength(1)
    // 复用 B 内容体 AgentLane:main + subagent 两组。
    expect(screen.getByText(/main agent/)).toBeDefined()
    expect(screen.getByText(/subagent agent-expl/)).toBeDefined()
    expect(screen.getByText(/3 req · 2 lanes/)).toBeDefined()
  })

  it("shadcn: back link navigates to the sessions list", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderDetail()
    fireEvent.click(screen.getByRole("link", { name: /sessions/i }))
    expect(screen.getByText("sessions-list")).toBeDefined()
  })
})
