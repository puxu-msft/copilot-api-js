import {
  //
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query"
import {
  //
  useCallback,
  useEffect,
  useMemo,
} from "react"

import type {
  //
  EntrySummary,
  SummaryResult,
} from "@/types"

import { useWs } from "@/hooks/useWs"
import { isTerminalSummary } from "@/lib/activity-row"
import { api } from "@/lib/api"
import { useListStore } from "@/stores/list-store"

const HISTORY_KEY = ["history-infinite"] as const

/** History 游标分页(已完成条目)。WS entry_added/entry_updated:仅当 summary 终态时合入,tail-on 失效首页/paused 记 buffer。 */
export function useHistoryInfinite() {
  const queryClient = useQueryClient()
  const dispatch = useListStore((s) => s.dispatch)
  const tailOn = useListStore((s) => s.tailOn)

  const query = useInfiniteQuery({
    queryKey: HISTORY_KEY,
    queryFn: ({ pageParam }) =>
      api.get<SummaryResult>(`/history/api/entries?limit=50&terminalOnly=true${pageParam ? `&cursor=${pageParam}&direction=older` : ""}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: SummaryResult) => last.nextCursor ?? undefined,
  })

  // 终态门控:一个请求只在真正终态(completed/failed/aborted/interrupted)时进 History 流。
  // 创建/进行态(active)归 Live 泳道,忽略。完成态后端走 entry_updated(非 entry_added,后者在创建态
  // 已发过),故 added/updated 统一处理——否则 paused 用户会漏掉以 entry_updated 到达的新完成条目。
  const onEntrySettled = useCallback(
    (s: EntrySummary) => {
      if (!isTerminalSummary(s)) return // active 在飞条目归 Live 泳道,不进 History
      dispatch({ kind: "incoming", id: s.id }) // tail-on:no-op 靠 invalidate;paused:记 buffer
      if (tailOn) void queryClient.invalidateQueries({ queryKey: HISTORY_KEY })
    },
    [dispatch, tailOn, queryClient],
  )
  const callbacks = useMemo(() => ({ onEntryAdded: onEntrySettled, onEntryUpdated: onEntrySettled }), [onEntrySettled])
  useWs(callbacks)

  const bufferedCount = useListStore((s) => s.bufferedIds.length)
  useEffect(() => {
    if (tailOn && bufferedCount === 0) void queryClient.invalidateQueries({ queryKey: HISTORY_KEY })
  }, [tailOn, bufferedCount, queryClient])

  const entries = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.entries), [query.data])
  const total = query.data?.pages[0]?.total ?? 0
  return { ...query, entries, total }
}
