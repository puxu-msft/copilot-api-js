/**
 * Tests for useHistoryStore composable — store actions & WebSocket handlers.
 *
 * Covers: selectAdjacentEntry, loadNext, loadPrev, setSearch, setSessionFilter,
 *         setEndpointFilter, setSuccessFilter, handleEntryAdded,
 *         handleEntryUpdated, handleStatsUpdated, computed properties
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"

import type { EntrySummary, HistoryEntry, HistoryStats, SummaryResult, SessionResult } from "../src/types"

// ─── Mocks ───

// Capture WSClient constructor options to invoke WS handlers in tests
let capturedWSOptions: Record<string, (...args: Array<any>) => void> = {}
const mockWSConnect = mock(() => {})
const mockWSDisconnect = mock(() => {})

mock.module("../src/api/ws", () => ({
  WSClient: class {
    constructor(options: Record<string, (...args: Array<any>) => void>) {
      capturedWSOptions = options
    }
    connect = mockWSConnect
    disconnect = mockWSDisconnect
  },
}))

const mockFetchEntries = mock<() => Promise<SummaryResult>>(() =>
  Promise.resolve({ entries: [], total: 0, nextCursor: null, prevCursor: null }),
)
const mockFetchEntry = mock<(id: string) => Promise<HistoryEntry>>(() => Promise.resolve(makeFullEntry("e1")))
const mockDeleteEntries = mock<() => Promise<void>>(() => Promise.resolve())
const mockFetchSessions = mock<() => Promise<SessionResult>>(() => Promise.resolve({ sessions: [], total: 0 }))

function makeStats(overrides: Partial<HistoryStats> = {}): HistoryStats {
  return {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    averageDurationMs: 0,
    modelDistribution: {},
    endpointDistribution: {},
    recentActivity: [],
    activeSessions: 0,
    ...overrides,
  }
}

const mockFetchStats = mock<() => Promise<HistoryStats>>(() => Promise.resolve(makeStats()))

mock.module("../src/api/http", () => ({
  api: {
    fetchEntries: mockFetchEntries,
    fetchEntry: mockFetchEntry,
    deleteEntries: mockDeleteEntries,
    fetchSessions: mockFetchSessions,
    fetchStats: mockFetchStats,
    getExportUrl: (format: string) => `/history/api/export?format=${format}`,
  },
}))

mock.module("../src/composables/useToast", () => ({
  useToast: () => ({ show: mock(() => {}) }),
}))

// Must import AFTER mocking
const { useHistoryStore } = await import("../src/composables/useHistoryStore")

// ─── Helpers ───

function makeSummary(id: string, overrides: Partial<EntrySummary> = {}): EntrySummary {
  return {
    id,
    sessionId: "s1",
    timestamp: Date.now(),
    endpoint: "anthropic-messages",
    requestModel: "claude-sonnet-4.6",
    previewText: `preview-${id}`,
    messageSummary: "2 msg",
    ...overrides,
  } as EntrySummary
}

function makeFullEntry(id: string): HistoryEntry {
  return {
    id,
    sessionId: "s1",
    timestamp: Date.now(),
    endpoint: "anthropic-messages",
    request: {
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "hello" }],
    },
  } as HistoryEntry
}

function resetMocks(): void {
  mockFetchEntries.mockClear()
  mockFetchEntry.mockClear()
  mockDeleteEntries.mockClear()
  mockFetchSessions.mockClear()
  mockFetchStats.mockClear()
  mockWSConnect.mockClear()
  mockWSDisconnect.mockClear()
  capturedWSOptions = {}
}

// ─── selectAdjacentEntry ───

describe("selectAdjacentEntry", () => {
  beforeEach(resetMocks)

  test("selects first entry when nothing selected and direction is next", async () => {
    const store = useHistoryStore()
    store.entries.value = [makeSummary("a"), makeSummary("b"), makeSummary("c")]
    store.selectedEntry.value = null

    store.selectAdjacentEntry("next")

    // Should call fetchEntry with first entry's id
    await new Promise((r) => setTimeout(r, 10))
    expect(mockFetchEntry).toHaveBeenCalledWith("a")
  })

  test("selects first entry when nothing selected and direction is prev", async () => {
    const store = useHistoryStore()
    store.entries.value = [makeSummary("a"), makeSummary("b")]
    store.selectedEntry.value = null

    store.selectAdjacentEntry("prev")

    await new Promise((r) => setTimeout(r, 10))
    expect(mockFetchEntry).toHaveBeenCalledWith("a")
  })

  test("moves to next entry", async () => {
    const store = useHistoryStore()
    store.entries.value = [makeSummary("a"), makeSummary("b"), makeSummary("c")]
    store.selectedEntry.value = makeFullEntry("a")

    store.selectAdjacentEntry("next")

    await new Promise((r) => setTimeout(r, 10))
    expect(mockFetchEntry).toHaveBeenCalledWith("b")
  })

  test("moves to previous entry", async () => {
    const store = useHistoryStore()
    store.entries.value = [makeSummary("a"), makeSummary("b"), makeSummary("c")]
    store.selectedEntry.value = makeFullEntry("b")

    store.selectAdjacentEntry("prev")

    await new Promise((r) => setTimeout(r, 10))
    expect(mockFetchEntry).toHaveBeenCalledWith("a")
  })

  test("clamps at last entry when moving next", async () => {
    const store = useHistoryStore()
    store.entries.value = [makeSummary("a"), makeSummary("b")]
    store.selectedEntry.value = makeFullEntry("b")

    store.selectAdjacentEntry("next")

    await new Promise((r) => setTimeout(r, 10))
    // Should stay at last entry
    expect(mockFetchEntry).toHaveBeenCalledWith("b")
  })

  test("clamps at first entry when moving prev", async () => {
    const store = useHistoryStore()
    store.entries.value = [makeSummary("a"), makeSummary("b")]
    store.selectedEntry.value = makeFullEntry("a")

    store.selectAdjacentEntry("prev")

    await new Promise((r) => setTimeout(r, 10))
    expect(mockFetchEntry).toHaveBeenCalledWith("a")
  })

  test("does nothing when entries list is empty", () => {
    const store = useHistoryStore()
    store.entries.value = []
    store.selectedEntry.value = null

    store.selectAdjacentEntry("next")

    expect(mockFetchEntry).not.toHaveBeenCalled()
  })
})

// ─── loadNext / loadPrev (cursor-based pagination) ───

describe("loadNext / loadPrev", () => {
  beforeEach(resetMocks)

  test("loadNext does nothing when nextCursor is null", () => {
    const store = useHistoryStore()
    store.nextCursor.value = null

    store.loadNext()

    expect(mockFetchEntries).not.toHaveBeenCalled()
  })

  test("loadNext fetches when nextCursor is present", () => {
    const store = useHistoryStore()
    store.nextCursor.value = "cursor-abc"

    store.loadNext()

    expect(mockFetchEntries).toHaveBeenCalled()
  })

  test("loadPrev does nothing when prevCursor is null", () => {
    const store = useHistoryStore()
    store.prevCursor.value = null

    store.loadPrev()

    expect(mockFetchEntries).not.toHaveBeenCalled()
  })

  test("loadPrev fetches when prevCursor is present", () => {
    const store = useHistoryStore()
    store.prevCursor.value = "cursor-xyz"

    store.loadPrev()

    expect(mockFetchEntries).toHaveBeenCalled()
  })
})

// ─── Filter setters ───

describe("filter setters", () => {
  beforeEach(resetMocks)

  test("setSearch resets cursors and fetches", () => {
    const store = useHistoryStore()
    store.nextCursor.value = "some-cursor"
    store.prevCursor.value = "prev-cursor"

    store.setSearch("test query")

    expect(store.searchQuery.value).toBe("test query")
    expect(store.nextCursor.value).toBeNull()
    expect(store.prevCursor.value).toBeNull()
    expect(mockFetchEntries).toHaveBeenCalled()
  })

  test("setSessionFilter resets cursors and fetches", () => {
    const store = useHistoryStore()
    store.nextCursor.value = "some-cursor"

    store.setSessionFilter("session-42")

    expect(store.selectedSessionId.value).toBe("session-42")
    expect(store.nextCursor.value).toBeNull()
    expect(store.prevCursor.value).toBeNull()
    expect(mockFetchEntries).toHaveBeenCalled()
  })

  test("setEndpointFilter resets cursors and fetches", () => {
    const store = useHistoryStore()
    store.nextCursor.value = "some-cursor"

    store.setEndpointFilter("openai-chat")

    expect(store.filterEndpoint.value).toBe("openai-chat")
    expect(store.nextCursor.value).toBeNull()
    expect(store.prevCursor.value).toBeNull()
    expect(mockFetchEntries).toHaveBeenCalled()
  })

  test("setSuccessFilter resets cursors and fetches", () => {
    const store = useHistoryStore()
    store.nextCursor.value = "some-cursor"

    store.setSuccessFilter("true")

    expect(store.filterSuccess.value).toBe("true")
    expect(store.nextCursor.value).toBeNull()
    expect(store.prevCursor.value).toBeNull()
    expect(mockFetchEntries).toHaveBeenCalled()
  })

  test("setSessionFilter with null clears filter", () => {
    const store = useHistoryStore()
    store.selectedSessionId.value = "session-42"

    store.setSessionFilter(null)

    expect(store.selectedSessionId.value).toBeNull()
    expect(mockFetchEntries).toHaveBeenCalled()
  })
})

// ─── Computed properties ───

describe("computed properties", () => {
  beforeEach(resetMocks)

  test("hasSelection is false when no entry selected", () => {
    const store = useHistoryStore()
    store.selectedEntry.value = null
    expect(store.hasSelection.value).toBe(false)
  })

  test("hasSelection is true when entry selected", () => {
    const store = useHistoryStore()
    store.selectedEntry.value = makeFullEntry("e1")
    expect(store.hasSelection.value).toBe(true)
  })

  test("selectedIndex returns -1 when no selection", () => {
    const store = useHistoryStore()
    store.entries.value = [makeSummary("a"), makeSummary("b")]
    store.selectedEntry.value = null
    expect(store.selectedIndex.value).toBe(-1)
  })

  test("selectedIndex returns correct index", () => {
    const store = useHistoryStore()
    store.entries.value = [makeSummary("a"), makeSummary("b"), makeSummary("c")]
    store.selectedEntry.value = makeFullEntry("b")
    expect(store.selectedIndex.value).toBe(1)
  })

  test("selectedIndex returns -1 when selected entry not in list", () => {
    const store = useHistoryStore()
    store.entries.value = [makeSummary("a")]
    store.selectedEntry.value = makeFullEntry("missing")
    expect(store.selectedIndex.value).toBe(-1)
  })
})

// ─── clearSelection ───

describe("clearSelection", () => {
  beforeEach(resetMocks)

  test("sets selectedEntry to null", () => {
    const store = useHistoryStore()
    store.selectedEntry.value = makeFullEntry("e1")

    store.clearSelection()

    expect(store.selectedEntry.value).toBeNull()
  })
})

// ─── WebSocket handlers ───

describe("WebSocket handlers", () => {
  beforeEach(resetMocks)

  test("init connects WebSocket and captures handlers", () => {
    const store = useHistoryStore()
    store.init()

    expect(mockWSConnect).toHaveBeenCalled()
    expect(capturedWSOptions.onEntryAdded).toBeDefined()
    expect(capturedWSOptions.onEntryUpdated).toBeDefined()
    expect(capturedWSOptions.onStatsUpdated).toBeDefined()

    store.destroy()
  })

  test("destroy disconnects WebSocket", () => {
    const store = useHistoryStore()
    store.init()
    store.destroy()

    expect(mockWSDisconnect).toHaveBeenCalled()
  })

  test("onEntryAdded inserts at beginning when on first page (prevCursor is null)", () => {
    const store = useHistoryStore()
    store.prevCursor.value = null
    store.entries.value = [makeSummary("existing")]
    store.total.value = 1

    store.init()
    capturedWSOptions.onEntryAdded(makeSummary("new"))

    expect(store.entries.value[0].id).toBe("new")
    expect(store.entries.value[1].id).toBe("existing")
    expect(store.total.value).toBe(2)

    store.destroy()
  })

  test("onEntryAdded does not insert when not on first page (prevCursor is set)", () => {
    const store = useHistoryStore()
    store.prevCursor.value = "some-cursor"
    store.entries.value = [makeSummary("existing")]
    store.total.value = 21

    store.init()
    capturedWSOptions.onEntryAdded(makeSummary("new"))

    expect(store.entries.value).toHaveLength(1)
    expect(store.entries.value[0].id).toBe("existing")

    store.destroy()
  })

  test("onEntryAdded pops excess entries beyond limit (20)", () => {
    const store = useHistoryStore()
    store.prevCursor.value = null
    const twentyEntries = Array.from({ length: 20 }, (_, i) => makeSummary(`e${i}`))
    store.entries.value = twentyEntries
    store.total.value = 20

    store.init()
    capturedWSOptions.onEntryAdded(makeSummary("new"))

    expect(store.entries.value).toHaveLength(20) // still 20, not 21
    expect(store.entries.value[0].id).toBe("new") // new entry at front
    expect(store.entries.value[19].id).toBe("e18") // last of original entries was e19, now popped

    store.destroy()
  })

  test("onEntryUpdated updates entry in list", () => {
    const store = useHistoryStore()
    store.entries.value = [makeSummary("a"), makeSummary("b"), makeSummary("c")]
    const updatedB = makeSummary("b", { requestModel: "gpt-4o" })

    store.init()
    capturedWSOptions.onEntryUpdated(updatedB)

    expect(store.entries.value[1].requestModel).toBe("gpt-4o")

    store.destroy()
  })

  test("onEntryUpdated re-fetches selected entry", async () => {
    const store = useHistoryStore()
    store.entries.value = [makeSummary("a")]
    store.selectedEntry.value = makeFullEntry("a")

    store.init()
    capturedWSOptions.onEntryUpdated(makeSummary("a", { requestModel: "updated" }))

    await new Promise((r) => setTimeout(r, 10))
    expect(mockFetchEntry).toHaveBeenCalledWith("a")

    store.destroy()
  })

  test("onStatsUpdated updates stats", () => {
    const store = useHistoryStore()
    const newStats = makeStats({
      totalRequests: 42,
      successfulRequests: 40,
      failedRequests: 2,
      totalInputTokens: 10000,
      totalOutputTokens: 5000,
    })

    store.init()
    capturedWSOptions.onStatsUpdated(newStats)

    expect(store.stats.value).toEqual(newStats)

    store.destroy()
  })

  test("onStatusChange updates wsConnected", () => {
    const store = useHistoryStore()

    store.init()
    capturedWSOptions.onStatusChange(true)
    expect(store.wsConnected.value).toBe(true)

    capturedWSOptions.onStatusChange(false)
    expect(store.wsConnected.value).toBe(false)

    store.destroy()
  })
})

// ─── Detail panel state ───

describe("detail panel state", () => {
  beforeEach(resetMocks)

  test("initial detail state values", () => {
    const store = useHistoryStore()

    expect(store.detailSearch.value).toBe("")
    expect(store.detailFilterRole.value).toBe("")
    expect(store.detailFilterType.value).toBe("")
    expect(store.aggregateTools.value).toBe(true)
    expect(store.detailViewMode.value).toBeNull()
    expect(store.showOnlyRewritten.value).toBe(false)
  })

  test("detail state is mutable", () => {
    const store = useHistoryStore()

    store.detailSearch.value = "search term"
    store.detailFilterRole.value = "user"
    store.detailFilterType.value = "tool_use"
    store.aggregateTools.value = false
    store.detailViewMode.value = "diff"
    store.showOnlyRewritten.value = true

    expect(store.detailSearch.value).toBe("search term")
    expect(store.detailFilterRole.value).toBe("user")
    expect(store.detailFilterType.value).toBe("tool_use")
    expect(store.aggregateTools.value).toBe(false)
    expect(store.detailViewMode.value).toBe("diff")
    expect(store.showOnlyRewritten.value).toBe(true)
  })
})
