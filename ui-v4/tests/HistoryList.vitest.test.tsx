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
  waitFor,
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

import type { RequestFilters } from "@/lib/request-filters"
import type { EntrySummary } from "@/types"

import { DEFAULT_COLUMN_VISIBILITY } from "@/lib/request-columns"
import { EMPTY_FILTERS } from "@/lib/request-filters"
import {
  //
  initialListState,
  useListStore,
} from "@/stores/list-store"

// hoisted 供 vi.mock 工厂引用的 spy:虚拟列表 scrollToIndex + 单条 summary 查询。
const { scrollToIndexMock, apiGetMock } = vi.hoisted(() => ({ scrollToIndexMock: vi.fn(), apiGetMock: vi.fn() }))

// fake TableVirtuoso:确定性渲染(不依赖 jsdom layout/initialItemCount),并经 useImperativeHandle
// 暴露 scrollToIndex spy 供定位断言。忠实复现 HistoryList 用到的契约:Table/TableRow 子组件 +
// fixedHeaderContent(表头)+ itemContent(单元格)+ context 注入。真实 Virtuoso 集成由 PoC 测试独立覆盖。
vi.mock("react-virtuoso", async () => {
  const {
    //
    forwardRef,
    useImperativeHandle,
  } = await import("react")
  const FakeTableVirtuoso = forwardRef(function FakeTableVirtuoso(props: Record<string, unknown>, ref: unknown) {
    const data = props.data as Array<{ id: string }>
    const context = props.context
    const components = props.components as { Table: React.ComponentType<Record<string, unknown>>; TableRow: React.ComponentType<Record<string, unknown>> }
    const fixedHeaderContent = props.fixedHeaderContent as () => React.ReactNode
    const itemContent = props.itemContent as (index: number, row: unknown) => React.ReactNode
    useImperativeHandle(ref as React.Ref<unknown>, () => ({ scrollToIndex: scrollToIndexMock }))
    const Table = components.Table
    const Row = components.TableRow
    return (
      <Table style={{}}>
        <thead>{fixedHeaderContent()}</thead>
        <tbody>
          {data.map((row, i) => (
            <Row
              key={row.id}
              item={row}
              context={context}
            >
              {itemContent(i, row)}
            </Row>
          ))}
        </tbody>
      </Table>
    )
  })
  return { TableVirtuoso: FakeTableVirtuoso }
})

vi.mock("@/lib/api", () => ({ api: { get: apiGetMock } }))

// 可变 mock:各用例设置 entries/hasNextPage/fetchNextPage;工厂在调用时读取(非 import 时)。
let mockHistory: {
  entries: Array<EntrySummary>
  total: number
  isLoading: boolean
  hasNextPage: boolean
  fetchNextPage: () => void
  isError?: boolean
  error?: unknown
  refetch?: () => void
} = { entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }

vi.mock("@/hooks/useHistoryInfinite", () => ({
  useHistoryInfinite: () => mockHistory,
}))

const { HistoryList, LOCATE_PAGE_CAP } = await import("@/components/requests/HistoryList")

/** 最小可渲染 History 行(activity-row helpers 对缺省字段有守卫)。 */
function entry(id: string): EntrySummary {
  return { id, startedAt: 0, endpoint: "anthropic-messages", state: "completed", requestModel: "m" } as unknown as EntrySummary
}

/**
 * `GET /history/api/entries/:id` 返回的单条 `HistoryEntry`(归属判定的输入)。忠实于真实契约:
 * `inboundRequest` 是必填对象(HistoryList 的 entryToGatingSummary 直接取 `inboundRequest.model`),
 * summary 形状(缺 inboundRequest)会在投影时抛错 → 不代表生产行为。
 */
function fetchedEntry(id: string, endpoint: string): unknown {
  return { id, endpoint, startedAt: 0, state: "completed", inboundRequest: { model: "m" } }
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

function renderList(initialEntries: Array<string> = ["/requests"], filters: RequestFilters = EMPTY_FILTERS, onClearFilters?: () => void) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={initialEntries}>
        <HistoryList
          filters={filters}
          onClearFilters={onClearFilters}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("HistoryList", () => {
  beforeEach(() => {
    mockHistory = { entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }
    useListStore.setState({ ...initialListState })
    scrollToIndexMock.mockClear()
    // 默认单条查询解析为一条匹配 anthropic-messages 的 summary(EMPTY_FILTERS 下恒属于筛选集)。
    apiGetMock.mockReset()
    apiGetMock.mockResolvedValue(fetchedEntry("x", "anthropic-messages"))
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
    // 高亮真值 = URL `at`;滚动走 virtuosoRef.scrollToIndex(见下方定位用例)。这里断言选中样式 + tail 暂停。
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2")], total: 2 }
    const { container } = renderList(["/requests?at=e2"])

    const row = container.querySelector<HTMLElement>('[data-entry-id="e2"]')
    expect(row).not.toBeNull()
    expect(row?.className).toContain("border-l-2")
    expect(useListStore.getState().tailOn).toBe(false)
  })

  it("renders each loaded entry as a row (TableVirtuoso + TanStack column model)", () => {
    mockHistory = { ...mockHistory, entries: [entry("a"), entry("b"), entry("c")], total: 3 }
    const { container } = renderList()
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

  // ── Task 3.3:scrollToIndex 定位 + at×筛选归属判定 + flash 高亮 ──

  it("?at in loaded set → scrollToIndex(center) + flashes the hit row (no per-id fetch)", async () => {
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2")], total: 2 }
    const { container } = renderList(["/requests?at=e2"])
    await waitFor(() => expect(scrollToIndexMock).toHaveBeenCalledWith({ index: 1, align: "center" }))
    const row = container.querySelector<HTMLElement>('[data-entry-id="e2"]')
    expect(row?.className).toContain("toc-flash")
    // 已在已加载集 → 不查单条 summary。
    expect(apiGetMock).not.toHaveBeenCalled()
  })

  it("?at not in set + does NOT match filters → out-of-filter notice, never pages", async () => {
    const fetchNextPage = vi.fn()
    mockHistory = { entries: [entry("e1")], total: 99, isLoading: false, hasNextPage: true, fetchNextPage }
    // 单条 summary 的 endpoint 与激活筛选不同 → matchesGating false。
    apiGetMock.mockResolvedValue(fetchedEntry("deep", "openai-chat"))
    const filters: RequestFilters = { ...EMPTY_FILTERS, endpoint: "anthropic-messages" }
    renderList(["/requests?at=deep"], filters)
    await screen.findByText(/不在当前筛选内/)
    expect(fetchNextPage).not.toHaveBeenCalled()
  })

  it("?at not in set + matches filters → load-until-found (pages within cap)", async () => {
    const fetchNextPage = vi.fn()
    mockHistory = { entries: [entry("e1")], total: 99, isLoading: false, hasNextPage: true, fetchNextPage }
    apiGetMock.mockResolvedValue(fetchedEntry("deep", "anthropic-messages"))
    const filters: RequestFilters = { ...EMPTY_FILTERS, endpoint: "anthropic-messages" }
    renderList(["/requests?at=deep"], filters)
    await waitFor(() => expect(fetchNextPage).toHaveBeenCalled())
  })

  it("out-of-filter notice: clicking [清除筛选并定位] calls onClearFilters", async () => {
    const onClearFilters = vi.fn()
    const fetchNextPage = vi.fn()
    mockHistory = { entries: [entry("e1")], total: 99, isLoading: false, hasNextPage: true, fetchNextPage }
    apiGetMock.mockResolvedValue(fetchedEntry("deep", "openai-chat"))
    const filters: RequestFilters = { ...EMPTY_FILTERS, endpoint: "anthropic-messages" }
    renderList(["/requests?at=deep"], filters, onClearFilters)
    const btn = await screen.findByText(/清除筛选并定位/)
    fireEvent.click(btn)
    expect(onClearFilters).toHaveBeenCalled()
  })

  it("load-until-found: fetches next page when ?at matches filters, is not in window, and there is more", async () => {
    const fetchNextPage = vi.fn()
    mockHistory = { entries: [entry("e1")], total: 99, isLoading: false, hasNextPage: true, fetchNextPage }
    renderList(["/requests?at=deep"])
    await waitFor(() => expect(fetchNextPage).toHaveBeenCalled())
  })

  it("load-until-found: keeps paging as new pages arrive until the target is revealed, then scrolls to it", async () => {
    // fetchNextPage 每次揭示一页(改 mockHistory.entries);第 REVEAL_ON 页放入目标 → 命中滚动。
    const REVEAL_ON = 3
    let page = 0
    const fetchNextPage = vi.fn(() => {
      page += 1
      const next = page >= REVEAL_ON ? entry("deep") : entry(`filler-${page}`)
      mockHistory = { ...mockHistory, entries: [...mockHistory.entries, next], hasNextPage: page < REVEAL_ON }
    })
    mockHistory = { entries: [entry("e1")], total: 99, isLoading: false, hasNextPage: true, fetchNextPage }
    // 每次都造新元素(非同一引用),避免 React 对 `===` 元素跳过子树重渲染 → effect 得以随新页重跑。
    const makeUi = () => (
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/requests?at=deep"]}>
          <HistoryList filters={EMPTY_FILTERS} />
        </MemoryRouter>
      </QueryClientProvider>
    )
    const { rerender } = render(makeUi())
    // 归属解析 → 首次翻页。
    await waitFor(() => expect(fetchNextPage).toHaveBeenCalled())
    // 每次 rerender 反映新页 → effect 重跑 → 继续翻页,直至目标出现被 scrollToIndex 命中。
    for (let i = 0; i < REVEAL_ON + 2 && scrollToIndexMock.mock.calls.length === 0; i += 1) {
      rerender(makeUi())
      await Promise.resolve()
    }
    expect(scrollToIndexMock).toHaveBeenCalledWith({ index: expect.any(Number), align: "center" })
    expect(fetchNextPage.mock.calls.length).toBeGreaterThanOrEqual(REVEAL_ON)
  })

  it("load-until-found: stops at LOCATE_PAGE_CAP when the target never appears (no runaway paging)", async () => {
    // 目标永不出现,hasNextPage 恒真 → 唯一的终止是 LOCATE_PAGE_CAP。
    let page = 0
    const fetchNextPage = vi.fn(() => {
      page += 1
      mockHistory = { ...mockHistory, entries: [...mockHistory.entries, entry(`filler-${page}`)], hasNextPage: true }
    })
    mockHistory = { entries: [entry("e1")], total: 99999, isLoading: false, hasNextPage: true, fetchNextPage }
    const makeUi = () => (
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/requests?at=deep"]}>
          <HistoryList filters={EMPTY_FILTERS} />
        </MemoryRouter>
      </QueryClientProvider>
    )
    const { rerender } = render(makeUi())
    await waitFor(() => expect(fetchNextPage).toHaveBeenCalled())
    for (let i = 0; i < LOCATE_PAGE_CAP + 5; i += 1) {
      rerender(makeUi())
      await Promise.resolve()
    }
    expect(scrollToIndexMock).not.toHaveBeenCalled()
    expect(fetchNextPage.mock.calls.length).toBe(LOCATE_PAGE_CAP)
  })

  it("no infinite loop: ?at missing entirely and no more page → never pages", async () => {
    const fetchNextPage = vi.fn()
    mockHistory = { entries: [entry("e1")], total: 1, isLoading: false, hasNextPage: false, fetchNextPage }
    renderList(["/requests?at=deep"])
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled())
    expect(fetchNextPage).not.toHaveBeenCalled()
  })

  it("does not touch tail or fetch when there is no ?at", () => {
    const fetchNextPage = vi.fn()
    mockHistory = { entries: [entry("e1")], total: 1, isLoading: false, hasNextPage: false, fetchNextPage }
    renderList(["/requests"])
    expect(fetchNextPage).not.toHaveBeenCalled()
    expect(apiGetMock).not.toHaveBeenCalled()
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
    expect(useListStore.getState().tailOn).toBe(false)
    fireEvent.click(screen.getByText(/resume/))
    expect(useListStore.getState().tailOn).toBe(true)
    expect(screen.getByTestId("loc").textContent).toBe("/requests")
  })

  // ── Task 4.1:error / empty 三态 ──

  it("error state: renders the error message and 重试 calls refetch", () => {
    const refetch = vi.fn()
    mockHistory = { entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn(), isError: true, error: new Error("boom"), refetch }
    renderList()
    expect(screen.getByText(/boom/)).toBeDefined()
    fireEvent.click(screen.getByText("重试"))
    expect(refetch).toHaveBeenCalled()
  })

  it("empty state with active filters: renders 清除筛选 and calls onClearFilters", () => {
    const onClearFilters = vi.fn()
    mockHistory = { entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }
    const filters: RequestFilters = { ...EMPTY_FILTERS, endpoint: "anthropic-messages" }
    renderList(["/requests"], filters, onClearFilters)
    expect(screen.getByText(/无匹配请求/)).toBeDefined()
    fireEvent.click(screen.getByText("清除筛选"))
    expect(onClearFilters).toHaveBeenCalled()
  })

  it("empty state without filters: 无匹配请求 only, no 清除筛选 button", () => {
    mockHistory = { entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }
    renderList()
    expect(screen.getByText(/无匹配请求/)).toBeDefined()
    expect(screen.queryByText("清除筛选")).toBeNull()
  })
})
