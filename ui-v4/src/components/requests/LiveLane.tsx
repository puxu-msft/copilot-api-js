import { RequestRow } from "@/components/requests/RequestRow"
import { useLiveStore } from "@/stores/live-store"

/** Live 泳道 —— spec §4.2:常驻、固定高度、内部独立滚动、空时空态、永不分页。 */
export function LiveLane() {
  const byId = useLiveStore((s) => s.byId)
  const rows = Object.values(byId)
  return (
    <div className="border-b-2 border-[#2f6f3f] bg-[#14201a]">
      <div className="mono px-2 py-1 text-[12px] uppercase tracking-wider text-[#7fd99a]">● Live · {rows.length} in-flight</div>
      <div className="max-h-[150px] overflow-y-auto">
        {rows.length === 0 ?
          <div className="mono px-2 py-2 text-[13px] text-[#4a6a4a]">无在飞请求</div>
        : rows.map((r) => (
            <RequestRow
              key={r.id}
              state={r.state}
              model={r.model}
              durationMs={r.durationMs}
              live
            />
          ))
        }
      </div>
    </div>
  )
}
