import {
  //
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import { useNavigate } from "react-router-dom"

import { LiveGroup } from "@/components/requests/LiveGroup"
import { useNowTick } from "@/hooks/useNowTick"
import { formatDuration } from "@/lib/format"
import { summarizeLive } from "@/lib/live-summary"
import { useLiveStore } from "@/stores/live-store"

const EXPANDED_KEY = "livedock.expanded"
function loadExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * 在途浮窗 —— 底部停靠、恒高折叠条 + 点击向上展开的分组明细面板(spec §3-§6)。
 * 折叠条恒高(single-line/nowrap/overflow),idle↔active 不改高度、不推挤 History。
 */
export function LiveDock() {
  const navigate = useNavigate()
  const byId = useLiveStore((s) => s.byId)
  const rows = useMemo(() => Object.values(byId), [byId])
  const active = rows.length > 0
  const nowMs = useNowTick(active)
  const summary = useMemo(() => summarizeLive(rows, nowMs), [rows, nowMs])

  const [expanded, setExpanded] = useState(loadExpanded)
  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0")
    } catch (err) {
      console.warn("[LiveDock] 展开态持久化失败:", err)
    }
  }, [expanded])

  // 无在途时强制收起(避免空面板);Escape 收起。
  const showPanel = expanded && active
  useEffect(() => {
    if (!showPanel) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false)
    }
    globalThis.addEventListener("keydown", onKey)
    return () => globalThis.removeEventListener("keydown", onKey)
  }, [showPanel])

  const onSelect = useCallback((id: string) => navigate(`/requests/${id}`), [navigate])
  const showHeaders = summary.groups.length > 1

  return (
    <>
      {showPanel ?
        <div className="absolute inset-x-0 bottom-0 z-10 max-h-[55%] overflow-auto border-t-2 border-[#2f6f3f] bg-[#0e1712] shadow-[0_-4px_12px_rgba(0,0,0,0.5)]">
          {summary.groups.map((g) => (
            <LiveGroup
              key={g.key}
              group={g}
              nowMs={nowMs}
              showHeader={showHeaders}
              onSelect={onSelect}
            />
          ))}
        </div>
      : null}
      <button
        type="button"
        aria-expanded={showPanel}
        disabled={!active}
        onClick={() => setExpanded((v) => !v)}
        className="mono flex h-6 w-full shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-t-2 border-[#2f6f3f] bg-[#14201a] px-2 text-left text-[12px] text-[#7fd99a] disabled:text-[#4a6a4a]"
      >
        {active ?
          <>
            <span>● {summary.count} in-flight</span>
            {summary.streaming > 0 ?
              <span className="text-[#7a9]">⚡{summary.streaming} streaming</span>
            : null}
            {summary.retrying > 0 ?
              <span className="text-[var(--color-warn)]">↻{summary.retrying} retrying</span>
            : null}
            <span className="text-[#688]">oldest {formatDuration(summary.oldestElapsedMs)}</span>
            <span className="ml-auto">{showPanel ? "▼" : "▲"}</span>
          </>
        : <span className="text-[#4a6a4a]">○ idle · 0 in-flight</span>}
      </button>
    </>
  )
}
