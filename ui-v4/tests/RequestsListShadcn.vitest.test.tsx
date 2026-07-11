/**
 * RequestsListShadcn fork-routed 测试(P2 §8.2)——渲染真实 `RequestsListPage`(DesignFork),由
 * `designVersion` 决定挂 legacy vs shadcn;shadcn 分支断言完整列表 + master 列配置三态(visibility 菜单 /
 * columnOrder 表头序 / resize 手柄)+ `?at=` 返回定位 + 行点击进整页详情 + 键盘 roving(prev/next 列表移动)。
 *
 * 沿用 legacy `HistoryList.vitest` 的 `FakeTableVirtuoso` 契约(虚拟化容器 fork 决策 = 选 A:保 TableVirtuoso)。
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

import type { WsCallbacks } from "@/lib/ws-client"
import type { EntrySummary } from "@/types"

const { scrollToIndexMock, apiGetMock, apiDeleteMock } = vi.hoisted(() => ({ scrollToIndexMock: vi.fn(), apiGetMock: vi.fn(), apiDeleteMock: vi.fn() }))

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
vi.mock("@/lib/ws-client", () => ({ wsClient: { acquire: (_cb: WsCallbacks) => () => {} } }))

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

vi.mock("@/hooks/useHistoryInfinite", () => ({ useHistoryInfinite: () => mockHistory }))

const { RequestsListPage } = await import("@/components/requests/RequestsListPage")
const { useUiStore } = await import("@/stores/ui-store")
const { useLiveStore } = await import("@/stores/live-store")
const { useListStore, initialListState } = await import("@/stores/list-store")

const COLUMN_STATE_KEY = "ui-v4:requests:column-state:v1"

function entry(id: string): EntrySummary {
  return { id, startedAt: 0, endpoint: "anthropic-messages", state: "completed", requestModel: "m" } as unknown as EntrySummary
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>
}

function renderPage(initialEntries: Array<string> = ["/requests"], withProbe = false) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={initialEntries}>
        <RequestsListPage />
        {withProbe ?
          <LocationProbe />
        : null}
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function headText(container: HTMLElement): string {
  return container.querySelector("thead")?.textContent ?? ""
}

describe("RequestsListPage · fork B (designVersion routes legacy vs shadcn)", () => {
  beforeEach(() => {
    mockHistory = { entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }
    apiGetMock.mockReset()
    apiGetMock.mockResolvedValue({ id: "x", endpoint: "anthropic-messages", startedAt: 0, state: "completed", inboundRequest: { model: "m" } })
    apiDeleteMock.mockReset()
    apiDeleteMock.mockResolvedValue({ success: true, deleted: 1 })
    scrollToIndexMock.mockClear()
    useLiveStore.setState({ byId: {} })
    useListStore.setState({ ...initialListState })
    localStorage.clear()
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })
  afterEach(() => {
    localStorage.clear()
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })

  it("amber-legacy: mounts legacy list (no shadcn page-shell marker)", () => {
    renderPage()
    expect(screen.queryAllByTestId("requests-shadcn")).toHaveLength(0)
    // legacy 筛选栏仍在(search input aria-label 两树同名,但 requests-shadcn 缺席证明挂的是 legacy)。
    expect(screen.getByLabelText("Filter by search")).toBeDefined()
  })

  it("shadcn: mounts complete RequestsListShadcn (exclusive; legacy shell absent)", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    mockHistory = { ...mockHistory, entries: [entry("a"), entry("b")], total: 2 }
    const { container } = renderPage()
    expect(screen.queryAllByTestId("requests-shadcn")).toHaveLength(1)
    // 列表渲染每条加载条目为行(TableVirtuoso + TanStack 列模型,共用数据层)。
    expect(container.querySelectorAll("[data-entry-id]").length).toBe(2)
    // 默认可见列表头(REQUEST_COLUMNS 中性化,两树共用)。
    expect(headText(container)).toContain("Status")
    expect(headText(container)).toContain("Model")
  })
})

describe("RequestsListShadcn · master 列配置三态(dnd/resize/visibility)", () => {
  beforeEach(() => {
    mockHistory = { entries: [entry("a")], total: 1, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }
    apiGetMock.mockReset()
    apiGetMock.mockResolvedValue({ id: "x", endpoint: "anthropic-messages", startedAt: 0, state: "completed", inboundRequest: { model: "m" } })
    apiDeleteMock.mockReset()
    scrollToIndexMock.mockClear()
    useLiveStore.setState({ byId: {} })
    useListStore.setState({ ...initialListState })
    localStorage.clear()
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
  })
  afterEach(() => {
    localStorage.clear()
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })

  it("visibility: toggling a column in the shadcn menu hides its header and persists", async () => {
    const user = userEvent.setup()
    const { container } = renderPage()
    expect(headText(container)).toContain("Model")
    await user.click(screen.getByRole("button", { name: "Columns" }))
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Model/i }))
    await waitFor(() => expect(headText(container)).not.toContain("Model"))
    const stored = JSON.parse(localStorage.getItem(COLUMN_STATE_KEY) ?? "null") as { visibility?: Record<string, boolean> } | null
    expect(stored?.visibility?.model).toBe(false)
  })

  it("order: seeded columnOrder reflects in shadcn header th order (session gutter first)", () => {
    // 持久化自定义序:model 前置到 status 之前。useColumnState 读回 seed。
    localStorage.setItem(COLUMN_STATE_KEY, JSON.stringify({ order: ["session", "model", "status", "time", "dur", "cache", "preview", "response"] }))
    const { container } = renderPage()
    const heads = Array.from(container.querySelectorAll<HTMLElement>("thead th"))
    expect(heads[0].className).toContain("w-[10px]") // session gutter 恒首
    expect(heads[1].textContent).toBe("Model")
    expect(heads[2].textContent).toBe("Status")
  })

  it("resize: fixed columns carry a [data-resize-handle]; flexible/session columns do not", () => {
    const { container } = renderPage()
    const thByText = (t: string) => Array.from(container.querySelectorAll("thead th")).find((th) => th.textContent === t) as HTMLElement | undefined
    expect(thByText("Status")?.querySelector("[data-resize-handle]")).not.toBeNull()
    expect(thByText("Model")?.querySelector("[data-resize-handle]")).not.toBeNull()
    expect(thByText("Request")?.querySelector("[data-resize-handle]")).toBeNull()
    const sessionTh = Array.from(container.querySelectorAll("thead th")).find((th) => th.className.includes("w-[10px]")) as HTMLElement | undefined
    expect(sessionTh?.querySelector("[data-resize-handle]")).toBeNull()
  })

  it("dnd: non-session header th is sortable (useSortable aria-roledescription); session gutter is not", () => {
    const { container } = renderPage()
    const thByText = (t: string) => Array.from(container.querySelectorAll("thead th")).find((th) => th.textContent === t) as HTMLElement | undefined
    expect(thByText("Status")?.getAttribute("aria-roledescription")).not.toBeNull()
    const sessionTh = Array.from(container.querySelectorAll("thead th")).find((th) => th.className.includes("w-[10px]")) as HTMLElement | undefined
    expect(sessionTh?.getAttribute("aria-roledescription")).toBeNull()
  })
})

describe("RequestsListShadcn · detail entry (form A) + ?at positioning + keyboard nav", () => {
  beforeEach(() => {
    mockHistory = { entries: [entry("e1"), entry("e2"), entry("e3")], total: 3, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }
    apiGetMock.mockReset()
    apiGetMock.mockResolvedValue({ id: "x", endpoint: "anthropic-messages", startedAt: 0, state: "completed", inboundRequest: { model: "m" } })
    scrollToIndexMock.mockClear()
    useLiveStore.setState({ byId: {} })
    useListStore.setState({ ...initialListState })
    localStorage.clear()
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
  })
  afterEach(() => {
    localStorage.clear()
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })

  it("row click navigates to the full-page detail /requests/:id (form A)", () => {
    const { container } = renderPage(["/requests"], true)
    fireEvent.click(container.querySelector('[data-entry-id="e2"]') as HTMLElement)
    expect(screen.getByTestId("loc").textContent).toBe("/requests/e2")
  })

  it("?at row is highlighted (selection truth = URL) and pauses tail", () => {
    const { container } = renderPage(["/requests?at=e2"])
    const row = container.querySelector<HTMLElement>('[data-entry-id="e2"]')
    expect(row?.className).toContain("border-l-2")
    expect(row?.getAttribute("aria-current")).toBe("true")
    expect(useListStore.getState().tailOn).toBe(false)
  })

  it("keyboard nav: ArrowDown moves DOM focus to the next row (roving) — in-list prev/next", () => {
    const { container } = renderPage()
    const e1 = container.querySelector<HTMLElement>('[data-entry-id="e1"]')
    e1?.focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" })
    const e2 = container.querySelector<HTMLElement>('[data-entry-id="e2"]')
    expect(document.activeElement).toBe(e2)
    expect(e2?.getAttribute("data-focused")).toBe("true")
  })
})
