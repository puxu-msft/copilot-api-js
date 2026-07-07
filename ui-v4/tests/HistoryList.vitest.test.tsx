import type { VisibilityState } from "@tanstack/react-table"

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

import type { EntrySummary } from "@/types"

import { DEFAULT_COLUMN_VISIBILITY } from "@/lib/request-columns"
import { EMPTY_FILTERS } from "@/lib/request-filters"
import {
  //
  initialListState,
  useListStore,
} from "@/stores/list-store"

// 可变 mock:各用例设置 entries/hasNextPage/fetchNextPage;工厂在调用时读取(非 import 时)。
let mockHistory: {
  entries: Array<EntrySummary>
  total: number
  isLoading: boolean
  hasNextPage: boolean
  fetchNextPage: () => void
} = { entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }

vi.mock("@/hooks/useHistoryInfinite", () => ({
  useHistoryInfinite: () => mockHistory,
}))

const { HistoryList } = await import("@/components/requests/HistoryList")

/** 最小可渲染 History 行(activity-row helpers 对缺省字段有守卫)。 */
function entry(id: string): EntrySummary {
  return { id, startedAt: 0, endpoint: "anthropic-messages", state: "completed", requestModel: "m" } as unknown as EntrySummary
}

/** 暴露当前 location 供导航断言(clear-at)。 */
function LocationProbe() {
  const loc = useLocation()
  return (
    <div data-testid="loc">
      {loc.pathname}
      {loc.search}
    </div>
  )
}

function renderList(initialEntries: Array<string> = ["/requests"]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={initialEntries}>
        <HistoryList filters={EMPTY_FILTERS} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("HistoryList", () => {
  beforeEach(() => {
    mockHistory = { entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }
    useListStore.setState({ ...initialListState })
  })
  afterEach(() => vi.restoreAllMocks())

  it("shows the buffer banner with count when paused with buffered ids", () => {
    useListStore.setState({ tailOn: false, bufferedIds: ["a", "b", "c"] })
    renderList()
    expect(screen.getByText(/3 条新请求/)).toBeDefined()
    expect(screen.getByText(/paused/)).toBeDefined()
  })
  it("no banner when tail-on", () => {
    renderList()
    expect(screen.queryByText(/条新请求/)).toBeNull()
    expect(screen.getByText(/live/)).toBeDefined()
  })

  it("locates the ?at row: highlights it (selection truth = URL) and pauses tail", () => {
    // 定位滚动本 task 走 virtuosoRef.scrollToIndex(imperative,不经 scrollIntoView);flash 高亮
    // 归 Task 3.3。这里断言选中真值(URL `at`)落在 e2 行 + tail 暂停这两个非滚动路径。
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2")], total: 2 }
    const { container } = renderList(["/requests?at=e2"])

    const row = container.querySelector<HTMLElement>('[data-entry-id="e2"]')
    expect(row).not.toBeNull()
    // 高亮真值 = URL:选中样式落在 e2 行(border-l 选中态)。
    expect(row?.className).toContain("border-l-2")
    // tail 暂停,避免新条目挤走定位行。
    expect(useListStore.getState().tailOn).toBe(false)
  })

  it("renders each loaded entry as a row (TableVirtuoso + TanStack column model)", () => {
    mockHistory = { ...mockHistory, entries: [entry("a"), entry("b"), entry("c")], total: 3 }
    const { container } = renderList()
    // 三条 entry → 三行(data-entry-id 承载行 id)。
    const rows = container.querySelectorAll("[data-entry-id]")
    expect(rows.length).toBe(3)
    expect(container.querySelector('[data-entry-id="a"]')).not.toBeNull()
    expect(container.querySelector('[data-entry-id="c"]')).not.toBeNull()
  })

  it("respects columnVisibility: a hidden column's header and cells do not render", () => {
    mockHistory = { ...mockHistory, entries: [entry("a")], total: 1 }
    const hidden: VisibilityState = { ...DEFAULT_COLUMN_VISIBILITY, model: false }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/requests"]}>
          <HistoryList
            filters={EMPTY_FILTERS}
            columnVisibility={hidden}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    // 未隐藏列表头仍在;model 列表头被隐藏。
    expect(screen.getByText("Status")).toBeDefined()
    expect(screen.queryByText("Model")).toBeNull()
  })

  it("clicking a row navigates to /requests/:id", () => {
    mockHistory = { ...mockHistory, entries: [entry("clickme")], total: 1 }
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/requests"]}>
          <HistoryList filters={EMPTY_FILTERS} />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const row = container.querySelector<HTMLElement>('[data-entry-id="clickme"]')
    expect(row).not.toBeNull()
    fireEvent.click(row as HTMLElement)
    expect(screen.getByTestId("loc").textContent).toBe("/requests/clickme")
  })

  it("load-until-found: fetches next page when ?at is not in the loaded window and there is more", () => {
    const fetchNextPage = vi.fn()
    mockHistory = { entries: [entry("e1")], total: 99, isLoading: false, hasNextPage: true, fetchNextPage }
    renderList(["/requests?at=deep"])
    expect(fetchNextPage).toHaveBeenCalled()
  })

  it("load-until-found: does NOT fetch when ?at is missing entirely and there is no more page (no infinite loop)", () => {
    const fetchNextPage = vi.fn()
    mockHistory = { entries: [entry("e1")], total: 1, isLoading: false, hasNextPage: false, fetchNextPage }
    renderList(["/requests?at=deep"])
    expect(fetchNextPage).not.toHaveBeenCalled()
  })

  it("does not touch tail or fetch when there is no ?at", () => {
    const fetchNextPage = vi.fn()
    mockHistory = { entries: [entry("e1")], total: 1, isLoading: false, hasNextPage: false, fetchNextPage }
    renderList(["/requests"])
    expect(fetchNextPage).not.toHaveBeenCalled()
    expect(useListStore.getState().tailOn).toBe(true)
  })

  it("resume while located re-enables tail and clears ?at (no re-pause fight)", () => {
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2")], total: 2 }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/requests?at=e2"]}>
          <HistoryList filters={EMPTY_FILTERS} />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    // 落地即暂停(定位态)。
    expect(useListStore.getState().tailOn).toBe(false)
    fireEvent.click(screen.getByText(/resume/))
    // resume 真正生效:tail 恢复,且 URL 清掉 at(URL-as-truth:tailing 态不声明 locate)。
    expect(useListStore.getState().tailOn).toBe(true)
    expect(screen.getByTestId("loc").textContent).toBe("/requests")
  })
})
