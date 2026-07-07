// HistoryList 的 endReached → fetchNextPage 接线测试(与主 HistoryList.vitest.test.tsx 分文件)。
//
// 为何分文件 + mock react-virtuoso:real TableVirtuoso 在 jsdom 下无 layout,`endReached`
// 永不触发(实测),故触底翻页的接线无法用真实滚动验证。主文件用真实 Virtuoso 验渲染/选中/列可见性;
// 本文件把 TableVirtuoso 换成挂载即调 `endReached` 的桩,确定性地验证 HistoryList 的 `hasNextPage`
// 门控接线(真实虚拟化的渲染正确性另由 requests-virtuoso.poc + 主文件覆盖)。

import {
  //
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import { render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import {
  //
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { EntrySummary } from "@/types"

import { EMPTY_FILTERS } from "@/lib/request-filters"
import {
  //
  initialListState,
  useListStore,
} from "@/stores/list-store"

// 挂载即触发 endReached 的 TableVirtuoso 桩(jsdom 无 layout,真实组件不会触发触底事件)。
vi.mock("react-virtuoso", async () => {
  const React = await import("react")
  return {
    TableVirtuoso: ({ endReached }: { endReached?: () => void }) => {
      React.useEffect(() => {
        endReached?.()
      }, [endReached])
      return null
    },
  }
})

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

function entry(id: string): EntrySummary {
  return { id, startedAt: 0, endpoint: "anthropic-messages", state: "completed", requestModel: "m" } as unknown as EntrySummary
}

function renderList() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/requests"]}>
        <HistoryList filters={EMPTY_FILTERS} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("HistoryList endReached wiring", () => {
  beforeEach(() => {
    useListStore.setState({ ...initialListState })
  })

  it("loads the next (older) page when there is one", () => {
    const fetchNextPage = vi.fn()
    mockHistory = { entries: [entry("a"), entry("b")], total: 99, isLoading: false, hasNextPage: true, fetchNextPage }
    renderList()
    expect(fetchNextPage).toHaveBeenCalled()
  })

  it("does NOT page when there is no next page (hasNextPage gate)", () => {
    const fetchNextPage = vi.fn()
    mockHistory = { entries: [entry("a"), entry("b")], total: 2, isLoading: false, hasNextPage: false, fetchNextPage }
    renderList()
    expect(fetchNextPage).not.toHaveBeenCalled()
  })
})
