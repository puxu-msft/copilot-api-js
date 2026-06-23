import {
  //
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  //
  useEffect,
  useMemo,
} from "react"

import type {
  //
  EntrySummary,
  SummaryResult,
} from "@/types"

import { useWs } from "@/hooks/useWs"
import { api } from "@/lib/api"
import { useListStore } from "@/stores/list-store"

const HISTORY_KEY = ["history-infinite"] as const

/** History 游标分页(已完成条目)。WS entry_added:tail-on 失效首页合入 / paused 记 buffer。 */
export function useHistoryInfinite() {
  const queryClient = useQueryClient()
  const dispatch = useListStore((s) => s.dispatch)
  const tailOn = useListStore((s) => s.tailOn)

  const query = useInfiniteQuery({
    queryKey: HISTORY_KEY,
    queryFn: ({ pageParam }) => api.get<SummaryResult>(`/history/api/entries?limit=50${pageParam ? `&cursor=${pageParam}&direction=older` : ""}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: SummaryResult) => last.nextCursor ?? undefined,
  })

  const callbacks = useMemo(
    () => ({
      onEntryAdded: (s: EntrySummary) => {
        dispatch({ kind: "incoming", id: s.id })
        if (tailOn) void queryClient.invalidateQueries({ queryKey: HISTORY_KEY })
      },
      onEntryUpdated: () => {
        if (tailOn) void queryClient.invalidateQueries({ queryKey: HISTORY_KEY })
      },
    }),
    [dispatch, tailOn, queryClient],
  )
  useWs(callbacks)

  const bufferedCount = useListStore((s) => s.bufferedIds.length)
  useEffect(() => {
    if (tailOn && bufferedCount === 0) void queryClient.invalidateQueries({ queryKey: HISTORY_KEY })
  }, [tailOn, bufferedCount, queryClient])

  const entries = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.entries), [query.data])
  const total = query.data?.pages[0]?.total ?? 0
  return { ...query, entries, total }
}
