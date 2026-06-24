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

import type { ActiveRequestInfo } from "@/types/ws"

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
      inboundRequest: { messages: [{ role: "user", content: "convo body text" }] },
    },
    isLoading: false,
    isError: false,
    error: null,
  }),
}))

const { RequestsListPage } = await import("@/components/requests/RequestsListPage")
const { RequestDetailPage } = await import("@/components/requests/RequestDetailPage")

/** Spy 当前 location.pathname,供导航断言。 */
function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname}</div>
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

  it("renders the Live lane and History section, no detail placeholder", () => {
    renderList()
    expect(screen.getByText(/● Live/)).toBeDefined()
    expect(screen.getByText(/History/)).toBeDefined()
    expect(screen.queryByText(/选一条请求看详情/)).toBeNull()
  })

  it("navigates to /requests/:id when a live row is clicked", () => {
    useLiveStore.getState().setSnapshot([{ id: "live1", model: "live-model" } as ActiveRequestInfo])
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/requests"]}>
          <LocationProbe />
          <Routes>
            <Route
              path="/requests"
              element={<RequestsListPage />}
            />
            <Route
              path="/requests/:id"
              element={<div>detail landing</div>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByTestId("location").textContent).toBe("/requests")
    fireEvent.click(screen.getByText(/live-model/))
    expect(screen.getByTestId("location").textContent).toBe("/requests/live1")
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
  it("navigates back to /requests when the back button is clicked", () => {
    renderDetail()
    expect(screen.getByTestId("location").textContent).toBe("/requests/r1")
    fireEvent.click(screen.getByText(/‹ 返回列表/))
    expect(screen.getByTestId("location").textContent).toBe("/requests")
  })
})
