import {
  //
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import {
  //
  render,
  screen,
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

import { HistoryList } from "@/components/requests/HistoryList"
import { useListStore } from "@/stores/list-store"

vi.mock("@/hooks/useHistoryInfinite", () => ({
  useHistoryInfinite: () => ({ entries: [], total: 0, isLoading: false, hasNextPage: false, fetchNextPage: () => {} }),
}))

function renderList() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <HistoryList />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("HistoryList", () => {
  beforeEach(() => {
    useListStore.setState({ tailOn: true, bufferedIds: [], selectedId: null })
  })
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
})
