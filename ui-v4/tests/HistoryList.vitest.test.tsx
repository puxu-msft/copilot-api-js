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
import userEvent from "@testing-library/user-event"
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
  PALETTE_STORAGE_KEY,
  SESSION_PALETTES,
} from "@/lib/session-color"
import {
  //
  initialListState,
  useListStore,
} from "@/stores/list-store"

// hoisted 供 vi.mock 工厂引用的 spy:虚拟列表 scrollToIndex + 单条 summary 查询。
const { scrollToIndexMock, apiGetMock, apiDeleteMock } = vi.hoisted(() => ({ scrollToIndexMock: vi.fn(), apiGetMock: vi.fn(), apiDeleteMock: vi.fn() }))

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
    const itemContent = props.itemContent as (index: number, row: unknown, context: unknown) => React.ReactNode
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
              {itemContent(i, row, context)}
            </Row>
          ))}
        </tbody>
      </Table>
    )
  })
  return { TableVirtuoso: FakeTableVirtuoso }
})

vi.mock("@/lib/api", () => ({ api: { get: apiGetMock, delete: apiDeleteMock } }))

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
const { LiveDock } = await import("@/components/requests/LiveDock")
const { useLiveStore } = await import("@/stores/live-store")

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
    apiDeleteMock.mockReset()
    apiDeleteMock.mockResolvedValue({ success: true, deleted: 1 })
  })
  afterEach(() => vi.restoreAllMocks())

  it("tail 控制(live/paused/resume)与合入横幅均已上移 LiveDock;HistoryList 头部不再渲染它们", () => {
    useListStore.setState({ tailOn: false, bufferedIds: ["a", "b", "c"] })
    renderList()
    // tail 状态 + 暂停/恢复控制已移到底部 LiveDock 状态栏(见 LiveDock.vitest)。
    expect(screen.queryByText(/paused|▶ live|resume/)).toBeNull()
    // 合入横幅也已上移。
    expect(screen.queryByText(/条新请求|待合入/)).toBeNull()
    // 头部仍保留 History 总数。
    expect(screen.getByText(/total/)).toBeDefined()
  })
  it("no merge banner and no tail indicator in HistoryList when tail-on (both moved to LiveDock)", () => {
    renderList()
    expect(screen.queryByText(/条新请求/)).toBeNull()
    expect(screen.queryByText(/▶ live|paused/)).toBeNull()
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

  it("LiveDock resume while HistoryList located: re-enables tail + clears ?at, and the at-effect does NOT re-pause (edge-triggered, deps exclude tailOn)", () => {
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2")], total: 2 }
    useLiveStore.setState({ byId: {} })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/requests?at=e2"]}>
          <HistoryList filters={EMPTY_FILTERS} />
          <LiveDock />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    // 定位(?at=e2)使 tail 暂停。
    expect(useListStore.getState().tailOn).toBe(false)
    // 点 LiveDock 的 ⏸ paused 开关恢复:tail 转 on + 清 ?at;且 HistoryList 的 at-effect
    // (deps 故意排除 tailOn、edge-triggered)不因 tailOn 变化把 tail 再暂停(否则 resume 在定位态永久失效)。
    fireEvent.click(screen.getByText(/paused/))
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

  // ── Task 4.2:列表键盘导航（↑/↓/Enter/Esc）+ 行 a11y。roving 焦点：DOM 焦点跟随游标，测试驱动真实焦点路径。 ──

  it("keyboard nav: ArrowDown moves DOM focus to the next row (roving) and scrolls it into view", () => {
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2"), entry("e3")], total: 3 }
    const { container } = renderList()
    const e1row = container.querySelector<HTMLElement>('[data-entry-id="e1"]')
    // 真实键盘路径：焦点先落在某行（初始 tab 停靠 = 首行），对该聚焦行派发 ArrowDown。
    e1row?.focus()
    expect(document.activeElement).toBe(e1row)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" })
    // DOM 焦点应随游标移到下一行（roving），且 scrollToIndex 带入视口（向下 → align end）。
    const e2row = container.querySelector<HTMLElement>('[data-entry-id="e2"]')
    expect(document.activeElement).toBe(e2row)
    expect(e2row?.getAttribute("data-focused")).toBe("true")
    expect(scrollToIndexMock).toHaveBeenLastCalledWith({ index: 1, align: "end" })
  })

  it("keyboard nav: ArrowDown ×2 moves focus/cursor to index 2 (third row)", () => {
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2"), entry("e3")], total: 3 }
    const { container } = renderList()
    container.querySelector<HTMLElement>('[data-entry-id="e1"]')?.focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" })
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" })
    expect(scrollToIndexMock).toHaveBeenLastCalledWith({ index: 2, align: "end" })
    const e3row = container.querySelector<HTMLElement>('[data-entry-id="e3"]')
    expect(document.activeElement).toBe(e3row)
    expect(e3row?.getAttribute("data-focused")).toBe("true")
  })

  it("keyboard nav: ArrowUp clamps at 0 (never negative)", () => {
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2"), entry("e3")], total: 3 }
    const { container } = renderList()
    const e1row = container.querySelector<HTMLElement>('[data-entry-id="e1"]')
    // 初始焦点 index 0（首行 tab 停靠），聚焦首行后 ArrowUp 应 clamp 在 0（向上 → align start），焦点不动。
    e1row?.focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" })
    expect(scrollToIndexMock).toHaveBeenLastCalledWith({ index: 0, align: "start" })
    expect(document.activeElement).toBe(e1row)
  })

  it("keyboard nav: Enter activates the CURSOR row, not the initially-focused row0 (real focus path)", () => {
    // 回归 oracle：Tab 落 row0 → ArrowDown ×2 游标到 e3 → Enter。roving 保证 DOM 焦点已随游标移到 e3，
    // Enter 由 e3 激活 → 打开 e3（而非旧 bug 的 row0/e1）。修复前 DOM 焦点滞留 e1，Enter 打开 e1 → 本用例失败。
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2"), entry("e3")], total: 3 }
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/requests"]}>
          <HistoryList filters={EMPTY_FILTERS} />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    container.querySelector<HTMLElement>('[data-entry-id="e1"]')?.focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" }) // 游标/焦点 → e2
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" }) // 游标/焦点 → e3
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" }) // 由聚焦行 e3 激活
    expect(screen.getByTestId("loc").textContent).toBe("/requests/e3")
  })

  it("keyboard nav: Escape clears the focus cursor and blurs", () => {
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2"), entry("e3")], total: 3 }
    const { container } = renderList()
    container.querySelector<HTMLElement>('[data-entry-id="e1"]')?.focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" }) // 焦点 → index 1 (e2)
    expect(container.querySelector('[data-focused="true"]')).not.toBeNull()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" })
    expect(container.querySelector('[data-focused="true"]')).toBeNull()
    // Esc 后不应再把焦点抢回旧行（focusRequestRef 已清）。
    expect(container.contains(document.activeElement)).toBe(false)
  })

  it("keyboard nav: isTyping guard — ArrowDown from inside an input does not move focus", () => {
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2"), entry("e3")], total: 3 }
    renderList()
    const scroller = screen.getByTestId("history-scroller")
    // 在滚动容器内放一个输入框并聚焦：方向键应被 isTyping 守卫拦下，不移动焦点游标。
    const input = document.createElement("input")
    scroller.append(input)
    input.focus()
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(scrollToIndexMock).not.toHaveBeenCalled()
  })

  it("row a11y: roving tabindex — only the tab-stop (cursor) row has tabIndex 0, others -1; all are role=button", () => {
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2"), entry("e3")], total: 3 }
    const { container } = renderList()
    const e1row = container.querySelector<HTMLElement>('[data-entry-id="e1"]')
    const e2row = container.querySelector<HTMLElement>('[data-entry-id="e2"]')
    // 初始游标 index 0 → e1 是唯一 tab 停靠（tabIndex 0），其余 -1（仅脚本/方向键可聚焦）。
    expect(e1row?.getAttribute("role")).toBe("button")
    expect(e2row?.getAttribute("role")).toBe("button")
    expect(e1row?.getAttribute("tabindex")).toBe("0")
    expect(e2row?.getAttribute("tabindex")).toBe("-1")
    // ArrowDown 后 tab 停靠随游标移到 e2。
    e1row?.focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" })
    expect(e1row?.getAttribute("tabindex")).toBe("-1")
    expect(e2row?.getAttribute("tabindex")).toBe("0")
  })

  it("row a11y: Enter on a focused row activates it (row-level activation)", () => {
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2"), entry("e3")], total: 3 }
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/requests"]}>
          <HistoryList filters={EMPTY_FILTERS} />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const row = container.querySelector<HTMLElement>('[data-entry-id="e2"]')
    row?.focus()
    fireEvent.keyDown(row as HTMLElement, { key: "Enter" })
    expect(screen.getByTestId("loc").textContent).toBe("/requests/e2")
  })

  it("row a11y: Space also activates the row", () => {
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2")], total: 2 }
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/requests"]}>
          <HistoryList filters={EMPTY_FILTERS} />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const row = container.querySelector<HTMLElement>('[data-entry-id="e1"]')
    fireEvent.keyDown(row as HTMLElement, { key: " " })
    expect(screen.getByTestId("loc").textContent).toBe("/requests/e1")
  })

  it("row a11y: the selected (?at) row carries aria-current", () => {
    mockHistory = { ...mockHistory, entries: [entry("e1"), entry("e2")], total: 2 }
    const { container } = renderList(["/requests?at=e2"])
    const row = container.querySelector<HTMLElement>('[data-entry-id="e2"]')
    expect(row?.getAttribute("aria-current")).toBe("true")
    const other = container.querySelector<HTMLElement>('[data-entry-id="e1"]')
    expect(other?.getAttribute("aria-current")).toBeNull()
  })

  // ── Task 4.3:筛选感知清空历史 + 确认 Modal ──

  it("clear (with filters): modal shows the filtered-count prompt; 确认 issues scoped delete + invalidates", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries")
    mockHistory = { ...mockHistory, entries: [entry("e1")], total: 3 }
    const filters: RequestFilters = { ...EMPTY_FILTERS, endpoint: "anthropic-messages" }
    renderList(["/requests"], filters)
    fireEvent.click(screen.getByText("清空"))
    // 有筛选 → 文案含「筛选命中的 3」。
    expect(screen.getByText(/筛选命中的 3/)).toBeDefined()
    fireEvent.click(screen.getByText("确认"))
    await waitFor(() => expect(apiDeleteMock).toHaveBeenCalled())
    const url = apiDeleteMock.mock.calls[0][0] as string
    expect(url).toContain("/history/api/entries?")
    expect(url).toContain("endpoint=anthropic-messages")
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["history-infinite"] }))
    // 删除后 Modal 关闭。
    await waitFor(() => expect(screen.queryByText("确认")).toBeNull())
  })

  it("clear (no filters): modal shows the clear-all prompt; 确认 issues an unscoped delete (no query)", async () => {
    mockHistory = { ...mockHistory, entries: [entry("e1")], total: 5 }
    renderList()
    fireEvent.click(screen.getByText("清空"))
    // 无筛选 → 文案「全部」+「5」。
    expect(screen.getByText(/全部 5/)).toBeDefined()
    fireEvent.click(screen.getByText("确认"))
    await waitFor(() => expect(apiDeleteMock).toHaveBeenCalledWith("/history/api/entries"))
  })

  it("clear: 取消 closes the modal without deleting", () => {
    mockHistory = { ...mockHistory, entries: [entry("e1")], total: 5 }
    renderList()
    fireEvent.click(screen.getByText("清空"))
    expect(screen.getByText("确认")).toBeDefined()
    fireEvent.click(screen.getByText("取消"))
    expect(screen.queryByText("确认")).toBeNull()
    expect(apiDeleteMock).not.toHaveBeenCalled()
  })
})

describe("HistoryList — 列宽 resize（Task 2）", () => {
  beforeEach(() => {
    mockHistory = { entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }
    useListStore.setState({ ...initialListState })
    scrollToIndexMock.mockClear()
    apiGetMock.mockReset()
    apiGetMock.mockResolvedValue(fetchedEntry("x", "anthropic-messages"))
    apiDeleteMock.mockReset()
    apiDeleteMock.mockResolvedValue({ success: true, deleted: 1 })
  })
  afterEach(() => vi.restoreAllMocks())

  /** 从 DOM 节点取 React 合成 props(fiber)——直接断言手柄的事件 props 存在(HIGH-2 无法从裸 DOM 查)。 */
  function reactProps(el: HTMLElement): Record<string, unknown> {
    const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))
    return key ? (el as unknown as Record<string, Record<string, unknown>>)[key] : {}
  }
  const thByText = (container: HTMLElement, t: string) =>
    Array.from(container.querySelectorAll("thead th")).find((th) => th.textContent === t) as HTMLElement | undefined

  it("固定列 th 带 resize 手柄([data-resize-handle]);session/弹性列(preview/response)无", () => {
    mockHistory = { ...mockHistory, entries: [entry("a")], total: 1 }
    const { container } = renderList()
    // 固定且默认可见列:status/model/cache 有手柄。
    expect(thByText(container, "Status")?.querySelector("[data-resize-handle]")).not.toBeNull()
    expect(thByText(container, "Model")?.querySelector("[data-resize-handle]")).not.toBeNull()
    expect(thByText(container, "Cache")?.querySelector("[data-resize-handle]")).not.toBeNull()
    // 弹性列(enableResizing:false)无手柄。
    expect(thByText(container, "Request")?.querySelector("[data-resize-handle]")).toBeNull()
    expect(thByText(container, "Response")?.querySelector("[data-resize-handle]")).toBeNull()
    // session gutter(w-[10px],enableResizing:false)无手柄。
    const sessionTh = Array.from(container.querySelectorAll("thead th")).find((th) => th.className.includes("w-[10px]")) as HTMLElement | undefined
    expect(sessionTh?.querySelector("[data-resize-handle]")).toBeNull()
  })

  it("固定列 th relative 定位(供手柄绝对定位)", () => {
    mockHistory = { ...mockHistory, entries: [entry("a")], total: 1 }
    const { container } = renderList()
    expect(thByText(container, "Status")?.className).toContain("relative")
  })

  it("手柄挂 onMouseDown/onTouchStart(resize 驱动)+ onPointerDown stopPropagation(HIGH-2:挡 Task 3 dnd pointerdown)", () => {
    mockHistory = { ...mockHistory, entries: [entry("a")], total: 1 }
    const { container } = renderList()
    const handle = thByText(container, "Status")?.querySelector<HTMLElement>("[data-resize-handle]")
    expect(handle).not.toBeNull()
    const props = reactProps(handle as HTMLElement)
    expect(typeof props.onMouseDown).toBe("function")
    expect(typeof props.onTouchStart).toBe("function")
    expect(typeof props.onPointerDown).toBe("function")
    // onPointerDown 须 stopPropagation:合成事件冒泡被拦(否则 Task 3 的 dnd useSortable pointerdown 会误触拖拽)。
    const stopPropagation = vi.fn()
    const evt = { stopPropagation } as unknown as React.PointerEvent
    ;(props.onPointerDown as (e: React.PointerEvent) => void)(evt)
    expect(stopPropagation).toHaveBeenCalled()
  })

  it("拖拽手柄(columnResizeMode:onChange)写回 onColumnSizingChange", () => {
    mockHistory = { ...mockHistory, entries: [entry("a")], total: 1 }
    const onColumnSizingChange = vi.fn()
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/requests"]}>
          <HistoryList
            filters={EMPTY_FILTERS}
            columnSizing={{}}
            onColumnSizingChange={onColumnSizingChange}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const handle = thByText(container, "Status")?.querySelector<HTMLElement>("[data-resize-handle]")
    expect(handle).not.toBeNull()
    // 模拟拖拽:mousedown 起手(TanStack 在 document 挂 mousemove)→ mousemove 位移 → onChange 模式即时写回。
    fireEvent.mouseDown(handle as HTMLElement, { clientX: 0 })
    fireEvent.mouseMove(document, { clientX: 40 })
    expect(onColumnSizingChange).toHaveBeenCalled()
    fireEvent.mouseUp(document)
  })
})

describe("HistoryList — 列策展 + cache 列 + inline width（Task 1）", () => {
  beforeEach(() => {
    mockHistory = { entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }
    useListStore.setState({ ...initialListState })
    scrollToIndexMock.mockClear()
    apiGetMock.mockReset()
    apiGetMock.mockResolvedValue(fetchedEntry("x", "anthropic-messages"))
    apiDeleteMock.mockReset()
    apiDeleteMock.mockResolvedValue({ success: true, deleted: 1 })
  })
  afterEach(() => vi.restoreAllMocks())

  it("默认视图隐藏策展列（endpoint/multiplier/tokens/attempts 表头不渲染），cache/status/model 显示", () => {
    mockHistory = { ...mockHistory, entries: [entry("a")], total: 1 }
    renderList()
    // 默认可见列。
    expect(screen.getByText("Status")).toBeDefined()
    expect(screen.getByText("Model")).toBeDefined()
    expect(screen.getByText("Cache")).toBeDefined()
    // 默认隐藏列表头缺席。
    expect(screen.queryByText("Endpoint")).toBeNull()
    expect(screen.queryByText("Tokens")).toBeNull()
    expect(screen.queryByText("Att")).toBeNull()
  })

  it("cache 列渲染命中率百分比单元格（read/(input+read+creation)）", () => {
    // 5 input + 15 read → 75%。
    const withUsage = { ...entry("a"), usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 15 } } as unknown as EntrySummary
    mockHistory = { ...mockHistory, entries: [withUsage], total: 1 }
    renderList()
    expect(screen.getByText("75%")).toBeDefined()
  })

  it("固定列 th 有 inline width style（=ColumnDef.size）；弹性列（preview/response）与 session 无 inline width", () => {
    mockHistory = { ...mockHistory, entries: [entry("a")], total: 1 }
    const { container } = renderList()
    const ths = Array.from(container.querySelectorAll("thead th"))
    const byText = (t: string) => ths.find((th) => th.textContent === t) as HTMLElement | undefined
    // 固定列:status size 92 → width:92px。
    expect(byText("Status")?.style.width).toBe("92px")
    // model size 180。
    expect(byText("Model")?.style.width).toBe("180px")
    // cache size 64。
    expect(byText("Cache")?.style.width).toBe("64px")
    // 弹性列 preview（"Request"）/ response（"Response"）无 inline width。
    expect(byText("Request")?.style.width).toBe("")
    expect(byText("Response")?.style.width).toBe("")
    // session gutter（表头文本空）无 inline width,靠 w-[10px] 类。
    const sessionTh = ths.find((th) => th.className.includes("w-[10px]")) as HTMLElement | undefined
    expect(sessionTh).toBeDefined()
    expect(sessionTh?.style.width).toBe("")
  })

  it("固定列 td 也带 inline width（table-fixed body 补齐防抖动）", () => {
    mockHistory = { ...mockHistory, entries: [entry("a")], total: 1 }
    const { container } = renderList()
    const row = container.querySelector('[data-entry-id="a"]') as HTMLElement
    const tds = Array.from(row.querySelectorAll("td"))
    // tds[0]=session 色列（w-[10px] p-0,无 inline width）;后续固定列有 inline width。
    expect(tds[0].style.width).toBe("")
    const statusTd = tds[1]
    expect(statusTd.style.width).toBe("92px")
  })
})

describe("HistoryList — session 色带（Task 2 默认态）", () => {
  beforeEach(() => {
    mockHistory = { entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }
    useListStore.setState({ ...initialListState })
    scrollToIndexMock.mockClear()
    apiGetMock.mockReset()
    apiGetMock.mockResolvedValue(fetchedEntry("x", "anthropic-messages"))
    apiDeleteMock.mockReset()
    apiDeleteMock.mockResolvedValue({ success: true, deleted: 1 })
  })
  afterEach(() => vi.restoreAllMocks())

  const withSessions = () => {
    mockHistory = {
      ...mockHistory,
      entries: [
        { ...entry("a"), sessionId: "S1" }, // main
        { ...entry("b"), sessionId: "S1", agentId: "ag1" }, // subagent
        { ...entry("c") }, // 无 session（entry() 默认无 sessionId）
      ],
      total: 3,
    }
  }

  it("带 session 行渲染色带按钮；无 session 行无（=2）", () => {
    withSessions()
    renderList(["/requests"])
    const bars = document.querySelectorAll('button[aria-label="toggle session highlight"]')
    expect(bars.length).toBe(2)
  })

  it("默认态：带 session 行有淡背景 rgba style", () => {
    withSessions()
    renderList(["/requests"])
    const rowA = document.querySelector('[data-entry-id="a"]') as HTMLElement
    expect(rowA.style.backgroundColor).toMatch(/^rgba\(/)
    const rowC = document.querySelector('[data-entry-id="c"]') as HTMLElement
    expect(rowC.style.backgroundColor).toBe("") // 无 session → 无背景
  })

  it("subagent 行 status 单元格缩进（pl-3），main 行不缩进", () => {
    withSessions()
    renderList(["/requests"])
    const rowB = document.querySelector('[data-entry-id="b"]') as HTMLElement
    const rowA = document.querySelector('[data-entry-id="a"]') as HTMLElement
    // tds[0]=session 色列, tds[1]=status
    expect(rowB.querySelectorAll("td")[1].className).toContain("pl-3")
    expect(rowA.querySelectorAll("td")[1].className).not.toContain("pl-3")
  })
})

describe("HistoryList — 多选对比 + 键盘 + 色板（Task 3）", () => {
  beforeEach(() => {
    mockHistory = { entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }
    useListStore.setState({ ...initialListState })
    scrollToIndexMock.mockClear()
    apiGetMock.mockReset()
    apiGetMock.mockResolvedValue(fetchedEntry("x", "anthropic-messages"))
    apiDeleteMock.mockReset()
    apiDeleteMock.mockResolvedValue({ success: true, deleted: 1 })
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  const twoSessions = () => {
    mockHistory = {
      ...mockHistory,
      entries: [
        { ...entry("a"), sessionId: "S1" },
        { ...entry("b"), sessionId: "S2" },
      ],
      total: 2,
    }
  }
  const bar = (id: string) => document.querySelector(`[data-entry-id="${id}"] button[aria-label="toggle session highlight"]`) as HTMLElement

  it("点色带 → 该会话行强背景、非选中行变灰", async () => {
    const user = userEvent.setup()
    twoSessions()
    renderList(["/requests"])
    await user.click(bar("a"))
    const rowA = document.querySelector('[data-entry-id="a"]') as HTMLElement
    const rowB = document.querySelector('[data-entry-id="b"]') as HTMLElement
    expect(rowA.style.backgroundColor).toMatch(/^rgba\(/) // A 强背景
    expect(rowB.className).toContain("opacity-40") // B 变灰
  })

  it("点色带 stopPropagation：不导航到 /requests/:id", async () => {
    const user = userEvent.setup()
    twoSessions()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/requests"]}>
          <HistoryList filters={EMPTY_FILTERS} />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await user.click(bar("a"))
    expect(screen.getByTestId("loc").textContent).toBe("/requests") // 未变 /requests/a
  })

  it("多选：再点 B → A、B 各自强背景、无行变灰", async () => {
    const user = userEvent.setup()
    twoSessions()
    renderList(["/requests"])
    await user.click(bar("a"))
    await user.click(bar("b"))
    const rowA = document.querySelector('[data-entry-id="a"]') as HTMLElement
    const rowB = document.querySelector('[data-entry-id="b"]') as HTMLElement
    expect(rowA.className).not.toContain("opacity-40")
    expect(rowB.className).not.toContain("opacity-40")
    expect(rowA.style.backgroundColor).toMatch(/^rgba\(/)
    expect(rowB.style.backgroundColor).toMatch(/^rgba\(/)
  })

  it("再点已选 A → 移出；集空回默认（无变灰）", async () => {
    const user = userEvent.setup()
    twoSessions()
    renderList(["/requests"])
    await user.click(bar("a"))
    await user.click(bar("a"))
    const rowB = document.querySelector('[data-entry-id="b"]') as HTMLElement
    expect(rowB.className).not.toContain("opacity-40")
  })

  it("键盘 f 聚焦光标行会话；Esc 清空选择集", () => {
    twoSessions()
    const { container } = renderList(["/requests"])
    const rowA = container.querySelector<HTMLElement>('[data-entry-id="a"]')
    rowA?.focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "f" }) // 光标在 index 0=a(S1)
    expect((container.querySelector('[data-entry-id="b"]') as HTMLElement).className).toContain("opacity-40")
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" })
    expect((container.querySelector('[data-entry-id="b"]') as HTMLElement).className).not.toContain("opacity-40")
  })

  it("切色板 → 行色带色变 + localStorage 持久化", async () => {
    const user = userEvent.setup()
    twoSessions()
    renderList(["/requests"])
    const before = bar("a").style.backgroundColor
    await user.click(screen.getByRole("combobox", { name: /色板/ }))
    await user.click(screen.getByRole("option", { name: SESSION_PALETTES[1].label }))
    expect(bar("a").style.backgroundColor).not.toBe(before)
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe("oceanic-jewel")
  })

  it("`?at=` 选中行豁免对比 dim：选中态优先于变灰（正样本对比 —— 未选中且非 at 行确实变灰）", async () => {
    // 三会话:a(S1, ?at= 选中行) / b(S2) / c(S3)。点 b 色带 → 选中集={S2}。
    // 断言:a 属未选中会话 S1 但因是 ?at= 选中行 → 不变灰(选中态优先);b 属选中会话 → 不变灰;
    // c 未选中且非选中行 → 变灰(证明 dim 逻辑确实在工作、只是豁免了 selected 行)。
    const user = userEvent.setup()
    mockHistory = {
      ...mockHistory,
      entries: [
        { ...entry("a"), sessionId: "S1" },
        { ...entry("b"), sessionId: "S2" },
        { ...entry("c"), sessionId: "S3" },
      ],
      total: 3,
    }
    renderList(["/requests?at=a"]) // 行 a = ?at= 选中行
    await user.click(bar("b")) // 聚焦 S2 → a 属未选中会话 S1
    const rowA = document.querySelector('[data-entry-id="a"]') as HTMLElement
    const rowB = document.querySelector('[data-entry-id="b"]') as HTMLElement
    const rowC = document.querySelector('[data-entry-id="c"]') as HTMLElement
    expect(rowA.className).not.toContain("opacity-40") // 选中态优先、豁免变灰
    expect(rowB.className).not.toContain("opacity-40") // 选中会话、不变灰
    expect(rowC.className).toContain("opacity-40") // 未选中且非选中行 → 变灰(dim 生效的正样本)
  })
})
