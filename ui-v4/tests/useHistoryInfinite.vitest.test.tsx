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
} from "@testing-library/react"
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
  api: { get: vi.fn(async () => ({ entries: [], total: 0, nextCursor: null, prevCursor: null })) },
}))

// import AFTER the mocks
const { useHistoryInfinite, gateIncoming } = await import("@/hooks/useHistoryInfinite")
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
