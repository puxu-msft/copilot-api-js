/**
 * useHistoryInfinite WS wiring — locks the terminal-gating contract that keeps
 * streaming requests out of the History list and stops paused users from losing
 * newly-completed entries (ui-v4 DESIGN §4.2 debts 1 & 2).
 *
 * Drives the hook's real WS callbacks via the same ws-client capture pattern as
 * useWs.vitest; api.get is stubbed so the infinite query never hits the network.
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

import type { WsCallbacks } from "@/lib/ws-client"
import type { EntrySummary } from "@/types"

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
const { useHistoryInfinite } = await import("@/hooks/useHistoryInfinite")
const { useListStore, initialListState } = await import("@/stores/list-store")

const summary = (over: Partial<EntrySummary>): EntrySummary => ({
  id: "x",
  startedAt: 0,
  endpoint: "anthropic-messages",
  messageCount: 0,
  previewText: "",
  ...over,
})

function Probe() {
  useHistoryInfinite()
  return null
}

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Probe />
    </QueryClientProvider>,
  )
}

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
