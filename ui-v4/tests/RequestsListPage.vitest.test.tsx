/**
 * RequestsListPage wiring (Task 2.5) — locks the integration seam:
 *  useRequestFilters (URL) → RequestsFilterBar / RequestFilterChips / HistoryList,
 *  and the crucial data-flow: `filters` reach `useHistoryInfinite` queryFn so the
 *  entries request URL carries the active dimensions (server-side refetch).
 *
 * We drive the REAL Page (no HistoryList/useHistoryInfinite mock) so the filters→
 * queryFn wiring is genuinely exercised. `api.get` is stubbed to capture the URL;
 * `ws-client` is stubbed so no real socket is opened in jsdom.
 */
import {
  //
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import {
  //
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import {
  //
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { WsCallbacks } from "@/lib/ws-client"

const apiGet = vi.fn(async (_path: string) => ({ entries: [], total: 0, nextCursor: null, prevCursor: null }))
vi.mock("@/lib/api", () => ({ api: { get: apiGet } }))
vi.mock("@/lib/ws-client", () => ({
  wsClient: {
    acquire: (_cb: WsCallbacks) => () => {},
  },
}))

// fake TableVirtuoso:jsdom 无 layout,真实 Virtuoso 不确定渲染表头/行;换成忠实复现 HistoryList
// 用到的契约(Table/TableRow 子组件 + fixedHeaderContent 表头 + itemContent 单元格 + context)
// 的确定性 fake,使列可见性经 columnVisibility → HistoryList 表头的显隐在 jsdom 里可断言。
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
    useImperativeHandle(ref as React.Ref<unknown>, () => ({ scrollToIndex: vi.fn() }))
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

// import AFTER the mocks
const { RequestsListPage } = await import("@/components/requests/RequestsListPage")
const { useListStore, initialListState } = await import("@/stores/list-store")
const { useLiveStore } = await import("@/stores/live-store")

function renderPage(initialEntries: Array<string> = ["/requests"]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={initialEntries}>
        <RequestsListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const COLUMN_STATE_KEY = "ui-v4:requests:column-state:v1"

describe("RequestsListPage wiring", () => {
  beforeEach(() => {
    apiGet.mockClear()
    useListStore.setState({ ...initialListState })
    useLiveStore.setState({ byId: {} })
    localStorage.clear()
  })

  it("flows URL filters into the useHistoryInfinite queryFn (entries request carries endpoint=)", async () => {
    renderPage(["/requests?endpoint=anthropic-messages"])
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    // 证 filters 真的流到了 HistoryList → useHistoryInfinite → queryFn 的请求 URL。
    const calledWithEndpoint = apiGet.mock.calls.some((c) => c[0].includes("endpoint=anthropic-messages"))
    expect(calledWithEndpoint).toBe(true)
  })

  it("no active filter → entries request carries no endpoint dimension", async () => {
    renderPage(["/requests"])
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    const anyEndpoint = apiGet.mock.calls.some((c) => c[0].includes("endpoint="))
    expect(anyEndpoint).toBe(false)
  })
})

describe("RequestsListPage column visibility (menu + persistence)", () => {
  beforeEach(() => {
    apiGet.mockClear()
    useListStore.setState({ ...initialListState })
    useLiveStore.setState({ byId: {} })
    localStorage.clear()
  })

  /** History 表头(fixedHeaderContent)在 fake virtuoso 的 <thead> 里;菜单项在 Radix Portal(body),故 thead 文本只含表头列。 */
  function headText(container: HTMLElement): string {
    return container.querySelector("thead")?.textContent ?? ""
  }

  it("toggling a column in the menu hides it in HistoryList and persists to localStorage", async () => {
    const user = userEvent.setup()
    const { container } = renderPage(["/requests"])
    // 初始:Model 列表头可见(等 useHistoryInfinite 首屏加载 settle → thead 渲染)。
    await waitFor(() => expect(headText(container)).toContain("Model"))

    await user.click(screen.getByRole("button", { name: "Columns" }))
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Model/i }))

    // 表头 Model 列消失(菜单里的 Model 项在 Portal,不在 thead)。
    await waitFor(() => expect(headText(container)).not.toContain("Model"))
    // 持久化到 localStorage 的版本化键(useColumnState 的 { visibility, sizing, order } 包裹形状)。
    const stored = JSON.parse(localStorage.getItem(COLUMN_STATE_KEY) ?? "null") as { visibility?: Record<string, boolean> } | null
    expect(stored?.visibility?.model).toBe(false)
  })

  it("restores column visibility from localStorage on remount", async () => {
    localStorage.setItem(COLUMN_STATE_KEY, JSON.stringify({ visibility: { model: false } }))
    const user = userEvent.setup()
    const { container } = renderPage(["/requests"])
    // 新实例读 localStorage → Model 列表头开箱即隐(等 thead settle,但 Model 始终不出现)。
    await waitFor(() => expect(container.querySelector("thead")?.textContent).toContain("Status"))
    expect(headText(container)).not.toContain("Model")
    // 菜单也反映持久化态。
    await user.click(screen.getByRole("button", { name: "Columns" }))
    expect(screen.getByRole("menuitemcheckbox", { name: /Model/i }).getAttribute("aria-checked")).toBe("false")
  })
})
