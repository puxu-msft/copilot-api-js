import {
  //
  computed,
  reactive,
  ref,
  shallowRef,
  type ComputedRef,
  type Ref,
} from "vue"

import type {
  //
  EndpointType,
  EntrySummary,
  HistoryEntry,
  HistoryStats,
  RequestLifecycleState,
} from "@/types"

import { api } from "@/api/http"

/**
 * All Activity list filter dimensions in one object — the single source of
 * truth. Mutate ONLY via `setFilter` (resets cursors + refetches). Adding a new
 * filter dimension = add a field here + a UI control; no new state ref / setter
 * needed (the old per-dimension setter sprawl is what let dimensions drift).
 */
export interface ActivityFilters {
  search: string
  endpoint: string | null
  /** "true" | "false" | null — coarse success filter. No UI control anymore (the 7-state `state` filter replaced it); kept as an API-compat surface + WS/legacy callers. */
  success: string | null
  /** Exact lifecycle state (7-state filter); wins over `success` server-side. */
  state: RequestLifecycleState | null
  model: string | null
  sessionId: string | null
  pid: number | null
  from: number | null
  to: number | null
}

export interface HistoryDataState {
  entries: Ref<Array<EntrySummary>>
  selectedEntry: Ref<HistoryEntry | null>
  stats: Ref<HistoryStats | null>
  filters: ActivityFilters
  searchQuery: ComputedRef<string>
  filterEndpoint: ComputedRef<string | null>
  filterSuccess: ComputedRef<string | null>
  selectedSessionId: ComputedRef<string | null>
  nextCursor: Ref<string | null>
  prevCursor: Ref<string | null>
  total: Ref<number>
  hasMore: Ref<boolean>
  loading: Ref<boolean>
  error: Ref<string | null>
  hasSelection: ComputedRef<boolean>
  selectedIndex: ComputedRef<number>
  pageSize: number
  fetchEntries: (cursor?: string, direction?: "older" | "newer") => Promise<void>
  fetchStats: () => Promise<void>
  selectEntry: (id: string) => Promise<void>
  selectAdjacentEntry: (direction: "next" | "prev") => void
  clearSelection: () => void
  refresh: () => Promise<void>
  loadNext: () => void
  loadPrev: () => void
  /** Single canonical filter mutation — sets one dimension, resets cursors, refetches. */
  setFilter: <K extends keyof ActivityFilters>(key: K, value: ActivityFilters[K]) => void
  clearFilter: (key: keyof ActivityFilters) => void
  clearFilters: () => void
  setSessionFilter: (id: string | null) => void
  setEndpointFilter: (ep: string | null) => void
  setSuccessFilter: (s: string | null) => void
  setSearch: (q: string) => void
}

export function useHistoryData(showToast: (message: string, type: "success" | "error") => void): HistoryDataState {
  const entries = ref<Array<EntrySummary>>([])
  const selectedEntry = ref<HistoryEntry | null>(null)
  const stats = ref<HistoryStats | null>(null)

  const filters = reactive<ActivityFilters>({
    search: "",
    endpoint: null,
    success: null,
    state: null,
    model: null,
    sessionId: null,
    pid: null,
    from: null,
    to: null,
  })
  // Backward-compat named refs over the single filters source.
  const searchQuery = computed(() => filters.search)
  const filterEndpoint = computed(() => filters.endpoint)
  const filterSuccess = computed(() => filters.success)
  const selectedSessionId = computed(() => filters.sessionId)

  const nextCursor = shallowRef<string | null>(null)
  const prevCursor = shallowRef<string | null>(null)
  const total = shallowRef(0)
  const hasMore = shallowRef(false)
  const loading = shallowRef(false)
  const error = shallowRef<string | null>(null)
  const pageSize = 20

  const hasSelection = computed(() => selectedEntry.value !== null)
  const selectedIndex = computed(() => {
    if (!selectedEntry.value) return -1
    return entries.value.findIndex((e) => e.id === selectedEntry.value?.id)
  })

  // Monotonic fetch token: a slow/early response (e.g. store.init()'s unfiltered
  // refresh racing a deep-link's filtered hydrate, or rapid setFilter calls) must
  // not overwrite the result of a newer request.
  let fetchSeq = 0

  async function fetchEntries(cursor?: string, direction?: "older" | "newer"): Promise<void> {
    const seq = ++fetchSeq
    loading.value = true
    error.value = null
    try {
      const result = await api.fetchEntries({
        cursor,
        direction,
        limit: pageSize,
        endpoint: filters.endpoint as EndpointType | undefined,
        success: filters.success === null ? undefined : filters.success === "true",
        state: filters.state ?? undefined,
        model: filters.model ?? undefined,
        search: filters.search || undefined,
        sessionId: filters.sessionId ?? undefined,
        pid: filters.pid ?? undefined,
        from: filters.from ?? undefined,
        to: filters.to ?? undefined,
      })
      if (seq !== fetchSeq) return // superseded by a newer fetch — drop this result
      entries.value = result.entries
      nextCursor.value = result.nextCursor
      prevCursor.value = result.prevCursor
      total.value = result.total
      hasMore.value = result.nextCursor !== null
      // NOTE: deliberately do NOT auto-select entries[0] here. The list page
      // doesn't need a selection (it only highlights the detail-page's current
      // entry), and auto-selecting fired a wasted fetchEntry on every load/
      // page-turn. The detail page drives selection explicitly via selectEntry.
    } catch (err) {
      if (seq !== fetchSeq) return
      const msg = err instanceof Error ? err.message : "Failed to load entries"
      error.value = msg
      showToast(msg, "error")
    } finally {
      if (seq === fetchSeq) loading.value = false
    }
  }

  async function fetchStats(): Promise<void> {
    try {
      stats.value = await api.fetchStats()
    } catch (err) {
      console.warn("[history] Failed to fetch stats:", err instanceof Error ? err.message : err)
    }
  }

  async function selectEntry(id: string): Promise<void> {
    try {
      selectedEntry.value = await api.fetchEntry(id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load entry"
      showToast(msg, "error")
    }
  }

  function selectAdjacentEntry(direction: "next" | "prev"): void {
    const idx = selectedIndex.value
    if (entries.value.length === 0) return

    let newIdx: number
    if (idx === -1) {
      newIdx = 0
    } else if (direction === "next") {
      newIdx = Math.min(idx + 1, entries.value.length - 1)
    } else {
      newIdx = Math.max(idx - 1, 0)
    }

    const entry = entries.value[newIdx]
    void selectEntry(entry.id)
  }

  function clearSelection(): void {
    selectedEntry.value = null
  }

  async function refresh(): Promise<void> {
    const currentId = selectedEntry.value?.id
    await Promise.all([fetchEntries(), fetchStats()])
    if (currentId) {
      await selectEntry(currentId)
    }
  }

  function loadNext(): void {
    if (!nextCursor.value) return
    void fetchEntries(nextCursor.value, "older")
  }

  function loadPrev(): void {
    if (!prevCursor.value) return
    void fetchEntries(prevCursor.value, "newer")
  }

  function resetCursors(): void {
    nextCursor.value = null
    prevCursor.value = null
  }

  function setFilter<K extends keyof ActivityFilters>(key: K, value: ActivityFilters[K]): void {
    filters[key] = value
    resetCursors()
    void fetchEntries()
  }

  /** Reset one filter dimension to its default (search→"", others→null). */
  function clearFilter(key: keyof ActivityFilters): void {
    ;(filters as Record<string, unknown>)[key] = key === "search" ? "" : null
    resetCursors()
    void fetchEntries()
  }

  /** Reset all filters, then refetch ONCE (avoids N refetches). */
  function clearFilters(): void {
    Object.assign(filters, { search: "", endpoint: null, success: null, state: null, model: null, sessionId: null, pid: null, from: null, to: null })
    resetCursors()
    void fetchEntries()
  }

  // Named setters delegate to the single setFilter path (no per-dimension logic).
  const setSessionFilter = (id: string | null) => setFilter("sessionId", id)
  const setEndpointFilter = (ep: string | null) => setFilter("endpoint", ep)
  const setSuccessFilter = (s: string | null) => setFilter("success", s)
  const setSearch = (q: string) => setFilter("search", q)

  return {
    entries,
    selectedEntry,
    stats,
    filters,
    searchQuery,
    filterEndpoint,
    filterSuccess,
    selectedSessionId,
    nextCursor,
    prevCursor,
    total,
    hasMore,
    loading,
    error,
    hasSelection,
    selectedIndex,
    pageSize,
    fetchEntries,
    fetchStats,
    selectEntry,
    selectAdjacentEntry,
    clearSelection,
    refresh,
    loadNext,
    loadPrev,
    setFilter,
    clearFilter,
    clearFilters,
    setSessionFilter,
    setEndpointFilter,
    setSuccessFilter,
    setSearch,
  }
}
