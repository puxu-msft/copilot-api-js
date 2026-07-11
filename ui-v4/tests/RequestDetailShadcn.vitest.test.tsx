/**
 * RequestDetailShadcn fork-routed 测试(P3 §8.2,决策 10)——渲染真实 `RequestDetailPage`(DesignFork),
 * 由 `designVersion` 决定挂 legacy(竖排 DetailSubRail sub-rail)vs shadcn(顶部水平 HorizontalTabs)。
 * shadcn 分支断言:水平 tablist(role=tab × 7 = SEGMENTS)+ tabpanel 内容复用 segment 内容体(B,逐字复用)
 * + 整页 chrome(返回列表 + Esc)。amber-legacy 分支断言竖排 sub-rail。
 */
import {
  //
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
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
  useLocation,
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

vi.mock("@/hooks/useEntry", () => ({
  useEntry: () => ({
    data: {
      id: "r1",
      startedAt: 0,
      endpoint: "anthropic-messages",
      state: "completed",
      clientRequest: { messages: [{ role: "user", content: "convo body text" }] },
    },
    isLoading: false,
    isError: false,
    error: null,
  }),
}))

// prev/next 由 useRequestNeighbors 据当前列表顺序算相邻 id;mock 列表顺序以控制邻居。
let mockEntries: Array<{ id: string }> = []
vi.mock("@/hooks/useHistoryInfinite", () => ({ useHistoryInfinite: () => ({ entries: mockEntries }) }))

const { RequestDetailPage } = await import("@/components/requests/RequestDetailPage")
const { useUiStore } = await import("@/stores/ui-store")

/** 7 段(顺序 = DetailSubRail SEGMENTS),shadcn 水平 tab 名逐一对齐。 */
const SEGMENTS = ["Convo", "System", "Stages", "Response", "SSE", "Headers", "Meta"] as const

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>
}

function renderDetail(initialEntries: Array<string> = ["/requests/r1"]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={initialEntries}>
        <LocationProbe />
        <Routes>
          <Route
            path="/requests/:id"
            element={<RequestDetailPage />}
          />
          <Route
            path="/requests"
            element={<div>list landing</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("RequestDetailPage · fork B (designVersion routes legacy vs shadcn)", () => {
  beforeEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))
  afterEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))

  it("amber-legacy: mounts legacy vertical sub-rail (no shadcn detail marker)", () => {
    renderDetail()
    expect(screen.queryAllByTestId("request-detail-shadcn")).toHaveLength(0)
    // legacy DetailSubRail 是竖排 Radix tablist。
    const tablist = screen.getByRole("tablist", { name: "Request detail segments" })
    expect(tablist.dataset.orientation).toBe("vertical")
  })

  it("shadcn: mounts RequestDetailShadcn with a HORIZONTAL tablist (exclusive; legacy absent)", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderDetail()
    expect(screen.queryAllByTestId("request-detail-shadcn")).toHaveLength(1)
    // 决策 10:竖排 sub-rail → 顶部水平 Tabs。
    const tablist = screen.getByRole("tablist", { name: "Request detail segments" })
    expect(tablist.dataset.orientation).toBe("horizontal")
  })

  it("shadcn: renders all 7 segments as tabs (names = SEGMENTS)", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderDetail()
    expect(screen.getAllByRole("tab")).toHaveLength(7)
    for (const name of SEGMENTS) expect(screen.getByRole("tab", { name })).toBeDefined()
  })

  it("shadcn: active tabpanel reuses the (B) segment content body verbatim", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderDetail()
    // 默认 active = Convo;ConvoSegment 渲染会话正文(与 legacy 同一内容体)。
    expect(screen.getAllByText(/convo body text/).length).toBeGreaterThan(0)
  })

  it("shadcn: back button returns to the list located at the entry (/requests?at=<id>)", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderDetail()
    expect(screen.getByTestId("loc").textContent).toBe("/requests/r1")
    fireEvent.click(screen.getByRole("button", { name: /返回列表/ }))
    expect(screen.getByTestId("loc").textContent).toBe("/requests?at=r1")
  })

  it("shadcn: Escape also returns to the list located at the entry", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderDetail()
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getByTestId("loc").textContent).toBe("/requests?at=r1")
  })

  it("shadcn: Escape is a no-op while a modal/dialog is open (modal handles Esc first)", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderDetail()
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    document.body.append(dialog)
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getByTestId("loc").textContent).toBe("/requests/r1")
    dialog.remove()
  })
})

describe("RequestDetailShadcn · prev/next neighbor navigation (decision 5, closes P2 M1)", () => {
  beforeEach(() => {
    // 列表顺序 [e0, r1, e2] ⟹ 当前 r1 的 prev=e0、next=e2。
    mockEntries = [{ id: "e0" }, { id: "r1" }, { id: "e2" }]
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
  })
  afterEach(() => {
    mockEntries = []
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })

  it("renders prev/next controls; next button navigates to the following entry (stays in detail)", () => {
    renderDetail()
    fireEvent.click(screen.getByRole("button", { name: /下一条/ }))
    expect(screen.getByTestId("loc").textContent).toBe("/requests/e2")
  })

  it("prev button navigates to the previous entry", () => {
    renderDetail()
    fireEvent.click(screen.getByRole("button", { name: /上一条/ }))
    expect(screen.getByTestId("loc").textContent).toBe("/requests/e0")
  })

  it("keyboard ArrowRight / j navigates to the next neighbor (bindKeys)", () => {
    renderDetail()
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }))
    })
    expect(screen.getByTestId("loc").textContent).toBe("/requests/e2")
  })

  it("at the last entry, next control is disabled (no next neighbor)", () => {
    mockEntries = [{ id: "e0" }, { id: "r1" }]
    renderDetail()
    expect(screen.getByRole("button", { name: /下一条/ })).toHaveProperty("disabled", true)
  })
})
