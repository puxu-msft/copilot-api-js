import {
  //
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import {
  //
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
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { useLiveStore } from "@/stores/live-store"

vi.mock("@/hooks/useLiveRequests", () => ({
  useLiveRequests: () => {},
}))
vi.mock("@/hooks/useHistoryInfinite", () => ({
  useHistoryInfinite: () => ({ entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: () => {} }),
}))
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

const { RequestsListPage } = await import("@/components/requests/RequestsListPage")
const { RequestDetailPage } = await import("@/components/requests/RequestDetailPage")

/** Spy 当前 location.pathname + search,供导航断言。 */
function LocationProbe() {
  const loc = useLocation()
  return (
    <div data-testid="location">
      {loc.pathname}
      {loc.search}
    </div>
  )
}

function renderList() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/requests"]}>
        <RequestsListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function renderDetail() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/requests/r1"]}>
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

describe("RequestsListPage", () => {
  afterEach(() => useLiveStore.getState().reset())

  it("renders the filter bar + history list, no detail placeholder", () => {
    // RequestsListPage 只渲染筛选条 + chips + HistoryList;在途 Live 泳道/LiveDock 已全局化到 AppShell
    // (见 LiveDock.vitest / LiveGroup.vitest 覆盖 live 行点击导航)。此处只断列表页本体渲染,不含 detail 占位。
    renderList()
    expect(screen.getByPlaceholderText("search text")).toBeDefined()
    // "选一条请求看详情" 只属 DetailPanel,列表页绝不出现。
    expect(screen.queryByText(/选一条请求看详情/)).toBeNull()
  })
})

describe("RequestDetailPage", () => {
  it("renders the back button + the DetailPanel", () => {
    renderDetail()
    expect(screen.getByText(/‹ 返回列表/)).toBeDefined()
    expect(screen.getByText(/anthropic-messages/)).toBeDefined()
    // "convo body text" appears in both the TOC label and the content body.
    expect(screen.getAllByText(/convo body text/).length).toBeGreaterThan(0)
  })
  it("back button returns to the list located at the entry (/requests?at=<id>)", () => {
    renderDetail()
    expect(screen.getByTestId("location").textContent).toBe("/requests/r1")
    fireEvent.click(screen.getByText(/‹ 返回列表/))
    expect(screen.getByTestId("location").textContent).toBe("/requests?at=r1")
  })
  it("Escape key also returns to the list located at the entry", () => {
    renderDetail()
    expect(screen.getByTestId("location").textContent).toBe("/requests/r1")
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getByTestId("location").textContent).toBe("/requests?at=r1")
  })
  it("Escape does nothing when a modal/dialog is open (the modal handles Esc first)", () => {
    renderDetail()
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    document.body.append(dialog)
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getByTestId("location").textContent).toBe("/requests/r1")
    dialog.remove()
  })
})
