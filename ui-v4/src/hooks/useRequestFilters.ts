import {
  //
  useCallback,
  useMemo,
} from "react"
import { useSearchParams } from "react-router-dom"

import type { RequestFilters } from "@/lib/request-filters"

import {
  //
  EMPTY_FILTERS,
  parseFilters,
  serializeFilters,
} from "@/lib/request-filters"

/** Filter keys owned by this hook — everything else in the URL (notably `at`) is preserved. */
const FILTER_KEYS: ReadonlyArray<keyof RequestFilters> = ["search", "model", "endpoint", "state", "pid", "sessionId", "from", "to"]

export function useRequestFilters() {
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(() => parseFilters(searchParams), [searchParams])

  // Write a whole RequestFilters back into the URL, preserving non-filter params (at).
  const write = useCallback(
    (next: RequestFilters) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev)
          for (const k of FILTER_KEYS) sp.delete(k)
          for (const [k, v] of serializeFilters(next)) sp.set(k, v)
          return sp
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const setFilter = useCallback(<K extends keyof RequestFilters>(k: K, v: RequestFilters[K]) => write({ ...filters, [k]: v }), [filters, write])
  const clearFilter = useCallback((k: keyof RequestFilters) => write({ ...filters, [k]: EMPTY_FILTERS[k] }), [filters, write])
  const clearAll = useCallback(() => write(EMPTY_FILTERS), [write])

  return { filters, setFilter, clearFilter, clearAll }
}
