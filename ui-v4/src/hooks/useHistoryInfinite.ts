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
import {
  //
  matchesGating,
  toQueryString,
  type RequestFilters,
} from "@/lib/request-filters"
import { useListStore } from "@/stores/list-store"

/** How a WS-arriving summary relates to the currently-loaded list. */
export type IncomingDisposition = "inplace" | "incoming" | "ignore"

/**
 * Decide a WS-arriving summary's disposition — **order is mutually exclusive (H4)**:
 *  1. already in the loaded list → `"inplace"` (patch that row, never buffer);
 *  2. else terminal AND passes `matchesGating` (no search dim) → `"incoming"`;
 *  3. else `"ignore"`.
 * The order must not flip: a late update to an already-completed row would
 * otherwise both patch in place AND wrongly re-enter the buffer.
 */
export function gateIncoming(s: EntrySummary, filters: RequestFilters, loadedIds: ReadonlySet<string>): IncomingDisposition {
  if (loadedIds.has(s.id)) return "inplace"
  if (!isTerminalSummary(s)) return "ignore"
  if (!matchesGating(s, filters)) return "ignore"
  return "incoming"
}

/**
 * History 游标分页(已完成条目)。`filters` 进 queryKey 驱动 server-side refetch;
 * WS entry_added/entry_updated 走 `gateIncoming` 门控:已在列表内 → 原地替换;
 * 否则仅当终态 && matchesGating 命中才入列(tail-on 失效首页/paused 记 buffer)。
 */
export function useHistoryInfinite(filters: RequestFilters) {
  const queryClient = useQueryClient()
  const dispatch = useListStore((s) => s.dispatch)
  const tailOn = useListStore((s) => s.tailOn)

  // filters 进 key:变更即换缓存条目,触发 server-side refetch(search 维也在 SQL 层生效)。
  const queryKey = useMemo(() => ["history-infinite", toQueryString(filters)] as const, [filters])

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => {
      const filterQs = toQueryString(filters)
      const page = pageParam ? `&cursor=${pageParam}&direction=older` : ""
      return api.get<SummaryResult>(`/history/api/entries?limit=50&terminalOnly=true${filterQs ? `&${filterQs}` : ""}${page}`)
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: SummaryResult) => last.nextCursor ?? undefined,
  })

  // 终态 + 筛选门控;顺序互斥(先原地替换、再入列),见 gateIncoming。
  // 完成态后端走 entry_updated(非 entry_added,后者在创建态已发过),故 added/updated 统一处理
  // ——否则 paused 用户会漏掉以 entry_updated 到达的新完成条目。
  const onEntrySettled = useCallback(
    (s: EntrySummary) => {
      const loaded = queryClient.getQueryData<{ pages: Array<SummaryResult> }>(queryKey)
      const loadedIds = new Set((loaded?.pages ?? []).flatMap((p) => p.entries.map((e) => e.id)))
      const disposition = gateIncoming(s, filters, loadedIds)
      if (disposition === "inplace") {
        // 已在列表内 → 原地替换该行,不论 tail;不再入 buffer(顺序互斥)。
        queryClient.setQueryData<{ pages: Array<SummaryResult> }>(queryKey, (old) =>
          !old ? old : (
            {
              ...old,
              pages: old.pages.map((p) => ({ ...p, entries: p.entries.map((e) => (e.id === s.id ? s : e)) })),
            }
          ),
        )
        return
      }
      if (disposition === "ignore") return
      // "incoming":新终态且门控命中 → 入列。tail-on:no-op 靠 invalidate;paused:记 buffer。
      dispatch({ kind: "incoming", id: s.id })
      if (tailOn) void queryClient.invalidateQueries({ queryKey })
    },
    [dispatch, tailOn, queryClient, filters, queryKey],
  )
  const callbacks = useMemo(() => ({ onEntryAdded: onEntrySettled, onEntryUpdated: onEntrySettled }), [onEntrySettled])
  useWs(callbacks)

  const bufferedCount = useListStore((s) => s.bufferedIds.length)
  useEffect(() => {
    if (tailOn && bufferedCount === 0) void queryClient.invalidateQueries({ queryKey })
  }, [tailOn, bufferedCount, queryClient, queryKey])

  const entries = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.entries), [query.data])
  const total = query.data?.pages[0]?.total ?? 0
  return { ...query, entries, total, isError: query.isError, error: query.error, refetch: query.refetch }
}
