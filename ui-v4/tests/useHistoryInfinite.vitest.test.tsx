/**
 * useHistoryInfinite WS wiring — locks two contracts:
 *  1. terminal-gating: only terminal summaries enter the History flow, and a
 *     paused user never loses a newly-completed entry (DESIGN §4.2 debts 1 & 2).
 *  2. filter-gating with mutually-exclusive order (H4): an in-list `entry_updated`
 *     is patched in place and MUST NOT also be buffered; a not-yet-listed summary
 *     enters the buffer only when terminal AND `matchesGating` (no search dim).
 *
 * Drives the hook's real WS callbacks via the same ws-client capture pattern as
 * useWs.vitest; api.get is stubbed so the infinite query never hits the network.
 * `gateIncoming` (the pure disposition fn the hook consumes) is unit-tested
 * directly — no React, no cache.
 */
import {
  //
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import {
  //
  act,
  render,
  screen,
  within,
} from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import {
  //
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { RequestFilters } from "@/lib/request-filters"
import type { WsCallbacks } from "@/lib/ws-client"
import type {
  //
  EntrySummary,
  SummaryResult,
} from "@/types"

import {
  //
  EMPTY_FILTERS,
  toQueryString,
} from "@/lib/request-filters"

let captured: WsCallbacks | null = null
vi.mock("@/lib/ws-client", () => ({
  wsClient: {
    acquire: (cb: WsCallbacks) => {
      captured = cb
      return () => {
        captured = null
      }
    },
  },
}))
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ entries: [], total: 0, nextCursor: null, prevCursor: null })), delete: vi.fn(async () => ({ success: true })) },
}))

// fake TableVirtuoso —— 确定性渲染(不依赖 jsdom layout),忠实复现 HistoryList 用到的
// Table/TableRow 子组件 + fixedHeaderContent + itemContent + context 注入。供下方端到端渲染用例:
// WS onEntryUpdated 原地改缓存后,真实 useReactTable → 行 DOM 得以重渲染出新值(全链验证)。
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
    useImperativeHandle(ref as React.Ref<unknown>, () => ({ scrollToIndex: () => {} }))
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
const { useHistoryInfinite, gateIncoming } = await import("@/hooks/useHistoryInfinite")
const { HistoryList } = await import("@/components/requests/HistoryList")
const { useListStore, initialListState } = await import("@/stores/list-store")

const summary = (over: Partial<EntrySummary>): EntrySummary => ({
  id: "x",
  startedAt: 0,
  endpoint: "anthropic-messages",
  messageCount: 0,
  previewText: "",
  ...over,
})

function Probe({ filters }: { filters: RequestFilters }) {
  useHistoryInfinite(filters)
  return null
}

function mount(filters: RequestFilters = EMPTY_FILTERS, client: QueryClient = new QueryClient()) {
  const utils = render(
    <QueryClientProvider client={client}>
      <Probe filters={filters} />
    </QueryClientProvider>,
  )
  return { ...utils, client }
}

describe("gateIncoming (pure disposition — order is mutually exclusive)", () => {
  it("in-list id → inplace, regardless of terminal/gating (checked FIRST)", () => {
    // Even a non-terminal, non-matching summary is treated as inplace when already listed.
    const s = summary({ id: "e1", state: "streaming", endpoint: "openai-chat-completions" })
    expect(gateIncoming(s, { ...EMPTY_FILTERS, endpoint: "anthropic-messages" }, new Set(["e1"]))).toBe("inplace")
  })
  it("not listed + terminal + matches gating → incoming", () => {
    const s = summary({ id: "new", state: "completed", endpoint: "anthropic-messages" })
    expect(gateIncoming(s, { ...EMPTY_FILTERS, endpoint: "anthropic-messages" }, new Set())).toBe("incoming")
  })
  it("not listed + terminal + does NOT match gating → ignore", () => {
    const s = summary({ id: "new", state: "completed", endpoint: "openai-chat-completions" })
    expect(gateIncoming(s, { ...EMPTY_FILTERS, endpoint: "anthropic-messages" }, new Set())).toBe("ignore")
  })
  it("not listed + non-terminal → ignore (Live lane)", () => {
    const s = summary({ id: "new", state: "streaming" })
    expect(gateIncoming(s, EMPTY_FILTERS, new Set())).toBe("ignore")
  })
})

describe("useHistoryInfinite WS terminal-gating", () => {
  beforeEach(() => {
    captured = null
    useListStore.setState({ ...initialListState })
  })

  it("paused: a terminal entry_updated is buffered (was silently lost before)", () => {
    useListStore.setState({ tailOn: false, bufferedIds: [] })
    mount()
    act(() => captured?.onEntryUpdated?.(summary({ id: "done", state: "completed" })))
    expect(useListStore.getState().bufferedIds).toEqual(["done"])
  })

  it("paused: a terminal aborted entry is buffered too", () => {
    useListStore.setState({ tailOn: false, bufferedIds: [] })
    mount()
    act(() => captured?.onEntryUpdated?.(summary({ id: "ab", state: "aborted" })))
    expect(useListStore.getState().bufferedIds).toEqual(["ab"])
  })

  it("paused: a non-terminal (active/streaming) event is ignored — belongs to the Live lane", () => {
    useListStore.setState({ tailOn: false, bufferedIds: [] })
    mount()
    act(() => captured?.onEntryUpdated?.(summary({ id: "live", state: "streaming" })))
    act(() => captured?.onEntryAdded?.(summary({ id: "live2", state: "streaming", active: true })))
    expect(useListStore.getState().bufferedIds).toEqual([])
  })

  it("tail-on: a terminal event is not buffered (it refetches into the first page)", () => {
    useListStore.setState({ tailOn: true, bufferedIds: [] })
    mount()
    act(() => captured?.onEntryUpdated?.(summary({ id: "done", state: "completed" })))
    expect(useListStore.getState().bufferedIds).toEqual([])
  })

  it("mounts tail-on, then pauses, then a terminal event arrives → buffered (latest-ref defeats stale tailOn)", () => {
    useListStore.setState({ tailOn: true, bufferedIds: [] })
    mount()
    act(() => useListStore.setState({ tailOn: false })) // user scrolls up / selects after mount
    act(() => captured?.onEntryUpdated?.(summary({ id: "late", state: "completed" })))
    expect(useListStore.getState().bufferedIds).toEqual(["late"])
  })
})

describe("useHistoryInfinite filter-gating (queryKey + order-exclusive WS)", () => {
  beforeEach(() => {
    captured = null
    useListStore.setState({ ...initialListState })
  })

  it("paused: a terminal entry NOT matching the active filters is ignored (no buffer)", () => {
    useListStore.setState({ tailOn: false, bufferedIds: [] })
    // Filter to anthropic-messages; a completed openai entry must NOT enter the buffer.
    mount({ ...EMPTY_FILTERS, endpoint: "anthropic-messages" })
    act(() => captured?.onEntryUpdated?.(summary({ id: "other", state: "completed", endpoint: "openai-chat-completions" })))
    expect(useListStore.getState().bufferedIds).toEqual([])
  })

  it("paused: a terminal entry matching the active filters IS buffered", () => {
    useListStore.setState({ tailOn: false, bufferedIds: [] })
    mount({ ...EMPTY_FILTERS, endpoint: "anthropic-messages" })
    act(() => captured?.onEntryUpdated?.(summary({ id: "hit", state: "completed", endpoint: "anthropic-messages" })))
    expect(useListStore.getState().bufferedIds).toEqual(["hit"])
  })

  it("in-list entry_updated patches the row in place BEFORE terminal gating (no double dispatch)", () => {
    useListStore.setState({ tailOn: false, bufferedIds: [] })
    // staleTime Infinity + pre-seeded page → mount does not refetch and clobber the seed.
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, gcTime: Number.POSITIVE_INFINITY } } })
    const key = ["history-infinite", toQueryString(EMPTY_FILTERS)]
    const page: SummaryResult = { entries: [summary({ id: "e1", state: "completed", requestModel: "old" })], total: 1, nextCursor: null, prevCursor: null }
    client.setQueryData(key, { pages: [page], pageParams: [undefined] })
    mount(EMPTY_FILTERS, client)

    act(() => captured?.onEntryUpdated?.(summary({ id: "e1", state: "completed", requestModel: "new" })))

    // 1) patched in place …
    const data = client.getQueryData<{ pages: Array<SummaryResult> }>(key)
    expect(data?.pages[0]?.entries[0]?.requestModel).toBe("new")
    // 2) … and NOT also buffered (order-exclusive: inplace path returns before the terminal gate).
    expect(useListStore.getState().bufferedIds).toEqual([])
  })
})

/**
 * 端到端真实渲染层(区别于上方 gateIncoming 纯函数层 + hook+cache 层):真实 `HistoryList`
 * + 真实 `useHistoryInfinite` + 真实 WS 回调,验证 Phase 1 Task 1.3 的门控顺序在渲染下成立——
 * paused 下同 id 的 `entry_updated` 到达时,行 DOM 被原地更新(新值可见)、bufferedIds 不增
 * (不误进缓冲横幅)。全链:WS → setQueryData → useInfiniteQuery → useReactTable → 行 DOM。
 */
describe("useHistoryInfinite end-to-end render (paused inline WS update preserves gating order)", () => {
  beforeEach(() => {
    captured = null
    useListStore.setState({ ...initialListState })
  })

  it("paused + in-list: entry_updated patches the row in the DOM (new value visible) and never buffers", async () => {
    useListStore.setState({ tailOn: false, bufferedIds: [] })
    // staleTime Infinity + 预置首页 → 挂载不 refetch 覆盖种子;真实 HistoryList 渲染该页。
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, gcTime: Number.POSITIVE_INFINITY } } })
    const key = ["history-infinite", toQueryString(EMPTY_FILTERS)]
    const page: SummaryResult = {
      entries: [summary({ id: "e1", state: "completed", requestModel: "old-model" })],
      total: 1,
      nextCursor: null,
      prevCursor: null,
    }
    client.setQueryData(key, { pages: [page], pageParams: [undefined] })

    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/requests"]}>
          <HistoryList filters={EMPTY_FILTERS} />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // 更新前:e1 行的 Model 单元格显示旧值。
    const row = container.querySelector<HTMLElement>('[data-entry-id="e1"]')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByText("old-model")).toBeDefined()

    // paused 下,同 id 的 entry_updated 到达(model/usage 变化)。async act 让 React Query 的 observer 通知 flush 到 DOM。
    await act(async () => {
      captured?.onEntryUpdated?.(summary({ id: "e1", state: "completed", requestModel: "new-model" }))
    })

    // 缓存已被原地改(独立 oracle:与 hook 层用例同一路径)。
    const data = client.getQueryData<{ pages: Array<SummaryResult> }>(key)
    expect(data?.pages[0]?.entries[0]?.requestModel).toBe("new-model")
    // 1) 行被原地更新:DOM 里出现新值、旧值消失(全链渲染,非仅缓存)。
    expect(await screen.findByText("new-model")).toBeDefined()
    expect(screen.queryByText("old-model")).toBeNull()
    // 2) bufferedIds 不增 + 无缓冲横幅(顺序互斥:inplace 先于终态门控 return,不误入 incoming/buffer)。
    expect(useListStore.getState().bufferedIds).toEqual([])
    expect(screen.queryByText(/条新请求/)).toBeNull()
  })
})
