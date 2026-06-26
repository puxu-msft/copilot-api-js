import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import {
  //
  createPinia,
  setActivePinia,
} from "pinia"

import type {
  //
  SearchResult,
  SearchResultRow,
} from "@/types"

// ── Mocks (must be declared before the dynamic import below) ──

const mockSearch = mock(async (): Promise<SearchResult> => ({ rows: [], nextCursor: null, partial: false }))
const mockSearchContains = mock(async (_hash: string) => ({ hash: "h", reqIds: ["r1", "r2"] }))

class FakeApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public bodyText: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

mock.module("../src/api/http", () => ({
  api: { search: mockSearch, searchContains: mockSearchContains },
  ApiError: FakeApiError,
}))

const { useSearchStore } = await import("../src/composables/useSearchStore")

function row(id: string, hash?: string): SearchResultRow {
  return {
    source: "inbound",
    hash,
    ownerReqId: id,
    snippet: `snippet for ${id}`,
    summary: { id, startedAt: 1, endpoint: "anthropic-messages", messageCount: 0, previewText: "" } as SearchResultRow["summary"],
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mockSearch.mockClear()
  mockSearchContains.mockClear()
})

describe("useSearchStore.runSearch", () => {
  test("empty query clears results without calling the API", async () => {
    const store = useSearchStore()
    store.query = "   "
    await store.runSearch()
    expect(mockSearch).not.toHaveBeenCalled()
    expect(store.rows).toEqual([])
    expect(store.hasSearched).toBe(false)
  })

  test("a query fetches, replaces rows, and records partial/cursor", async () => {
    mockSearch.mockResolvedValueOnce({ rows: [row("a"), row("b")], nextCursor: "c1", partial: true, builtPct: 0.4 })
    const store = useSearchStore()
    store.query = "needle"
    await store.runSearch()
    expect(mockSearch).toHaveBeenCalledTimes(1)
    expect(store.rows.map((r) => r.ownerReqId)).toEqual(["a", "b"])
    expect(store.nextCursor).toBe("c1")
    expect(store.partial).toBe(true)
    expect(store.builtPct).toBe(0.4)
    expect(store.hasSearched).toBe(true)
  })

  test("API error surfaces and clears results", async () => {
    mockSearch.mockRejectedValueOnce(new FakeApiError(400, "bad", "Invalid source"))
    const store = useSearchStore()
    store.query = "needle"
    await store.runSearch()
    expect(store.error).toContain("Invalid source")
    expect(store.rows).toEqual([])
  })
})

describe("useSearchStore.loadMore (forward-only append)", () => {
  test("appends the next page and updates the cursor", async () => {
    mockSearch.mockResolvedValueOnce({ rows: [row("a")], nextCursor: "c1", partial: false })
    const store = useSearchStore()
    store.query = "needle"
    await store.runSearch()

    mockSearch.mockResolvedValueOnce({ rows: [row("b")], nextCursor: null, partial: false })
    await store.loadMore()
    expect(store.rows.map((r) => r.ownerReqId)).toEqual(["a", "b"])
    expect(store.nextCursor).toBeNull()
  })

  test("no-op when there is no next cursor", async () => {
    const store = useSearchStore()
    await store.loadMore()
    expect(mockSearch).not.toHaveBeenCalled()
  })
})

describe("useSearchStore stale-resolve race", () => {
  test("an earlier-issued search resolving LAST does not overwrite the newer result", async () => {
    const store = useSearchStore()
    let resolveA!: (r: SearchResult) => void
    let resolveB!: (r: SearchResult) => void
    const pA = new Promise<SearchResult>((r) => (resolveA = r))
    const pB = new Promise<SearchResult>((r) => (resolveB = r))
    mockSearch.mockReturnValueOnce(pA).mockReturnValueOnce(pB)

    store.query = "a"
    const promA = store.runSearch() // search #1 (gen 1)
    store.query = "ab"
    const promB = store.runSearch() // search #2 (gen 2) — supersedes #1

    // Resolve the NEWER one first, then the stale older one.
    resolveB({ rows: [row("fromB")], nextCursor: "cB", partial: false })
    resolveA({ rows: [row("fromA")], nextCursor: "cA", partial: false })
    await Promise.all([promA, promB])

    expect(store.rows.map((r) => r.ownerReqId)).toEqual(["fromB"]) // B won; stale A discarded
    expect(store.nextCursor).toBe("cB")
  })
})

describe("useSearchStore.setSource", () => {
  test("switching facet re-runs the search", async () => {
    mockSearch.mockResolvedValue({ rows: [], nextCursor: null, partial: false })
    const store = useSearchStore()
    store.query = "needle"
    await store.runSearch()
    mockSearch.mockClear()

    store.setSource("req-headers")
    await Promise.resolve()
    expect(store.source).toBe("req-headers")
    expect(mockSearch).toHaveBeenCalledTimes(1)
  })

  test("switching to the same facet is a no-op", () => {
    const store = useSearchStore()
    store.setSource("inbound")
    expect(mockSearch).not.toHaveBeenCalled()
  })
})

describe("useSearchStore.fetchContains (lazy + cached)", () => {
  test("fetches once and caches by hash", async () => {
    const store = useSearchStore()
    const ids1 = await store.fetchContains("h1")
    const ids2 = await store.fetchContains("h1")
    expect(ids1).toEqual(["r1", "r2"])
    expect(ids2).toEqual(["r1", "r2"])
    expect(mockSearchContains).toHaveBeenCalledTimes(1) // cached on 2nd call
    expect(store.containsCache.h1).toEqual(["r1", "r2"])
  })
})
