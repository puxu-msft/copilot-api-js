import { useNavigate } from "react-router-dom"

import { RequestRow } from "@/components/requests/RequestRow"
import { useHistoryInfinite } from "@/hooks/useHistoryInfinite"
import { useListStore } from "@/stores/list-store"

/** History —— 游标分页 + 缓冲横幅 + tail 暂停 + 选中粘滞(spec §4.2)。 */
export function HistoryList() {
  const navigate = useNavigate()
  const selectedId = useListStore((s) => s.selectedId)
  const { entries, total, isLoading, hasNextPage, fetchNextPage } = useHistoryInfinite()
  const bufferedIds = useListStore((s) => s.bufferedIds)
  const tailOn = useListStore((s) => s.tailOn)
  const dispatch = useListStore((s) => s.dispatch)

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    if (e.currentTarget.scrollTop > 4 && tailOn) dispatch({ kind: "scroll-up" })
  }
  function selectRow(rowId: string) {
    dispatch({ kind: "select", id: rowId })
    navigate(`/requests/${rowId}`)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mono flex items-center gap-2 border-b border-[#222] px-2 py-1 text-[12px] uppercase tracking-wider text-[var(--color-muted)]">
        <span>History · {total} total</span>
        <span className="ml-auto">{tailOn ? "▶ live" : "⏸ paused"}</span>
        {!tailOn && (
          <button
            type="button"
            className="text-[var(--color-primary)]"
            onClick={() => dispatch({ kind: "resume" })}
          >
            resume
          </button>
        )}
      </div>
      {bufferedIds.length > 0 && (
        <button
          type="button"
          className="mono border-b border-[#4a3a55] bg-[#2a2230] py-1 text-center text-[14px] text-[#caa6e0]"
          onClick={() => dispatch({ kind: "flush" })}
        >
          ↓ {bufferedIds.length} 条新请求 —— 点此合入
        </button>
      )}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={onScroll}
      >
        {isLoading ?
          <div className="mono p-2 text-[#888]">loading…</div>
        : entries.map((e) => (
            <RequestRow
              key={e.id}
              entry={e}
              selected={e.id === selectedId}
              onClick={() => selectRow(e.id)}
            />
          ))
        }
        {hasNextPage && (
          <button
            type="button"
            className="mono w-full py-2 text-[13px] text-[var(--color-primary)]"
            onClick={() => void fetchNextPage()}
          >
            加载更多
          </button>
        )}
      </div>
    </div>
  )
}
