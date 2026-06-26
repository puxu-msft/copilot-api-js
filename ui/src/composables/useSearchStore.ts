import { defineStore } from "pinia"
import {
  //
  ref,
  shallowRef,
} from "vue"

import type {
  //
  SearchResultRow,
  SearchSource,
} from "@/types"

import {
  //
  api,
  ApiError,
} from "@/api/http"

/** Structural filters AND-ed with the text match (subset of QueryOptions the search endpoint accepts). */
export interface SearchFilters {
  model: string
  endpoint: string | null
  sessionId: string
}

const PAGE_SIZE = 30

function emptyFilters(): SearchFilters {
  return { model: "", endpoint: null, sessionId: "" }
}

/**
 * Dedicated content-addressed search store (5 facets). Forward-only cursor
 * pagination — `loadMore` APPENDS the next page (the backend search cursor is
 * keyset-forward, there is no "prev"). `partial` is surfaced while the backfill
 * is still indexing the inbound corpus.
 */
export const useSearchStore = defineStore("search", () => {
  const source = ref<SearchSource>("inbound")
  const query = ref("")
  const filters = ref<SearchFilters>(emptyFilters())

  const rows = shallowRef<Array<SearchResultRow>>([])
  const nextCursor = ref<string | null>(null)
  const partial = ref(false)
  const builtPct = ref<number | undefined>(undefined)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const hasSearched = ref(false)

  /** Lazy hash → containing request ids (the `inbound` "view N requests" expansion). */
  const containsCache = ref<Record<string, Array<string>>>({})

  // Monotonic generation token: a fresh runSearch bumps it so a slower earlier
  // request (debounced typing / facet switch) that resolves LATER is discarded
  // instead of clobbering the newer result set. loadMore binds to it too, so a
  // page appended under a superseded query/filter set is dropped.
  let searchGen = 0

  function buildParams(cursor?: string) {
    const f = filters.value
    return {
      source: source.value,
      q: query.value,
      limit: PAGE_SIZE,
      cursor,
      model: f.model.trim() || undefined,
      endpoint: f.endpoint ?? undefined,
      sessionId: f.sessionId.trim() || undefined,
    }
  }

  function describeError(err: unknown): string {
    if (err instanceof ApiError) return `${err.status}: ${err.bodyText}`
    return err instanceof Error ? err.message : "Search failed"
  }

  /** Run a fresh search (resets the result set + cursor). */
  async function runSearch(): Promise<void> {
    if (query.value.trim().length === 0) {
      searchGen += 1 // invalidate any in-flight request
      rows.value = []
      nextCursor.value = null
      partial.value = false
      builtPct.value = undefined
      error.value = null
      hasSearched.value = false
      return
    }
    const gen = ++searchGen
    loading.value = true
    error.value = null
    hasSearched.value = true
    try {
      const result = await api.search(buildParams())
      if (gen !== searchGen) return // superseded by a newer search
      rows.value = result.rows
      nextCursor.value = result.nextCursor
      partial.value = result.partial
      builtPct.value = result.builtPct
    } catch (err: unknown) {
      if (gen !== searchGen) return
      error.value = describeError(err)
      rows.value = []
      nextCursor.value = null
    } finally {
      if (gen === searchGen) loading.value = false
    }
  }

  /** Append the next page (no-op when there is no next cursor or a load is in flight). */
  async function loadMore(): Promise<void> {
    if (!nextCursor.value || loading.value) return
    const gen = searchGen // bind to the search generation that minted this cursor
    loading.value = true
    error.value = null
    try {
      const result = await api.search(buildParams(nextCursor.value))
      if (gen !== searchGen) return // a fresh search superseded this page
      rows.value = [...rows.value, ...result.rows]
      nextCursor.value = result.nextCursor
      partial.value = result.partial
      builtPct.value = result.builtPct
    } catch (err: unknown) {
      if (gen !== searchGen) return
      error.value = describeError(err)
    } finally {
      if (gen === searchGen) loading.value = false
    }
  }

  /** Switch the active facet and re-run (if there is a query). */
  function setSource(next: SearchSource): void {
    if (next === source.value) return
    source.value = next
    void runSearch()
  }

  /** Lazy-load the request ids referencing a message hash (cached). */
  async function fetchContains(hash: string): Promise<Array<string>> {
    if (Object.hasOwn(containsCache.value, hash)) return containsCache.value[hash]
    const { reqIds } = await api.searchContains(hash)
    containsCache.value = { ...containsCache.value, [hash]: reqIds }
    return reqIds
  }

  return {
    source,
    query,
    filters,
    rows,
    nextCursor,
    partial,
    builtPct,
    loading,
    error,
    hasSearched,
    containsCache,
    runSearch,
    loadMore,
    setSource,
    fetchContains,
  }
})
