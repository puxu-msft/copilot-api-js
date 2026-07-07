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
  waitFor,
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

import type { WsCallbacks } from "@/lib/ws-client"

const apiGet = vi.fn(async (_path: string) => ({ entries: [], total: 0, nextCursor: null, prevCursor: null }))
vi.mock("@/lib/api", () => ({ api: { get: apiGet } }))
vi.mock("@/lib/ws-client", () => ({
  wsClient: {
    acquire: (_cb: WsCallbacks) => () => {},
  },
}))

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

describe("RequestsListPage wiring", () => {
  beforeEach(() => {
    apiGet.mockClear()
    useListStore.setState({ ...initialListState })
    useLiveStore.setState({ byId: {} })
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
