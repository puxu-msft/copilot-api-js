import {
  //
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  //
  useLocation,
  useNavigate,
} from "react-router-dom"

import { LiveGroupShadcn } from "@/components/shell/shadcn/LiveGroupShadcn"
import { useGoLive } from "@/hooks/useGoLive"
import { useNowTick } from "@/hooks/useNowTick"
import { formatDuration } from "@/lib/format"
import { summarizeLive } from "@/lib/live-summary"
import { useListStore } from "@/stores/list-store"
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
 * fork C · shadcn LiveDock 呈现层(完整,决策 7)—— legacy `LiveDock` 的中性化孪生。承载:
 *  1. 在途请求信息(折叠摘要条 + 点击展开分组明细面板 `LiveGroupShadcn`)—— 全局显示。
 *  2. tail 暂停/恢复开关 + 「待合入」CTA(useGoLive + list-store)—— **请求列表专属**,仅 `/requests` 显示。
 *
 * 关键:读**同一常驻 live-store**(`useLiveStore`)—— fork 的是**呈现层**,数据源不 fork,故切换 designVersion
 * 不丢在飞请求(INV-FIDELITY-1:一次性 connected 快照由 L0 的 useLiveRequests 维护进 live-store,两版呈现层都读它)。
 * 中性语义 token,圆角随 `--radius`。`data-testid=dock-shadcn` 供 INV-2 互斥挂载守卫。
 * **live 信号色(绿 vs 琥珀)= 交用户 UX 检查项**(此处 in-flight/streaming 用 `text-primary`、retrying 用 `text-muted-foreground`)。
 */
export function ShadcnLiveDock(): React.ReactElement {
  const navigate = useNavigate()
  const byId = useLiveStore((s) => s.byId)
  const rows = useMemo(() => Object.values(byId), [byId])
  const active = rows.length > 0
  const nowMs = useNowTick(active)
  const summary = useMemo(() => summarizeLive(rows, nowMs), [rows, nowMs])

  // 缓冲的新完成请求(tail 暂停期间到达)——合入 CTA。tail 开关 + 该 CTA 均为请求列表专属控件。
  const bufferedCount = useListStore((s) => s.bufferedIds.length)
  const tailOn = useListStore((s) => s.tailOn)
  const dispatch = useListStore((s) => s.dispatch)
  const goLive = useGoLive()
  const onRequestsList = useLocation().pathname === "/requests"
  const showMerge = onRequestsList && !tailOn && bufferedCount > 0

  const [expanded, setExpanded] = useState(loadExpanded)
  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0")
    } catch (err) {
      console.warn("[ShadcnLiveDock] 展开态持久化失败:", err)
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

  const onSelect = useCallback((id: string) => void navigate(`/requests/${id}`), [navigate])
  const showHeaders = summary.groups.length > 1

  return (
    // fixed 浮岛:脱离子布局、悬浮视口底部。z-40 压过内容、让位 Dialog(z-50)。圆角随 `--radius`(neutral 树)。
    <div
      data-testid="dock-shadcn"
      className="fixed inset-x-3 bottom-3 z-40 flex flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl"
    >
      {showPanel ?
        <div className="max-h-[55vh] overflow-auto border-b border-border">
          {summary.groups.map((g) => (
            <LiveGroupShadcn
              key={g.key}
              group={g}
              nowMs={nowMs}
              showHeader={showHeaders}
              onSelect={onSelect}
            />
          ))}
        </div>
      : null}
      {/* 恒高状态条(h-8):左侧在途摘要(展开 toggle,flex-1)+ 右侧列表专属控件。独立可点区(不嵌套 button)。 */}
      <div className="mono flex h-8 w-full shrink-0 items-center gap-2 overflow-hidden px-3 text-sm whitespace-nowrap text-foreground">
        <button
          type="button"
          aria-expanded={showPanel}
          disabled={!active}
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden text-left whitespace-nowrap disabled:text-muted-foreground"
        >
          {active ?
            <>
              <span className="shrink-0 text-primary">● {summary.count} in-flight</span>
              {summary.streaming > 0 ?
                <span className="shrink-0 text-primary">⚡{summary.streaming} streaming</span>
              : null}
              {summary.retrying > 0 ?
                <span className="shrink-0 text-muted-foreground">↻{summary.retrying} retrying</span>
              : null}
              <span className="shrink-0 text-muted-foreground">oldest {formatDuration(summary.oldestElapsedMs)}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">{showPanel ? "▼" : "▲"}</span>
            </>
          : <span className="text-muted-foreground">○ idle · 0 in-flight</span>}
        </button>
        {showMerge ?
          <button
            type="button"
            onClick={() => goLive("flush")}
            title={`合入 ${bufferedCount} 条新完成请求到历史并恢复实时跟随`}
            className="shrink-0 border-l border-border pl-2 text-primary hover:text-foreground"
          >
            ↓ {bufferedCount} 待合入
          </button>
        : null}
        {/* 自动刷新(tail)开关 —— 请求列表专属:live 时点击暂停、paused 时点击恢复。别页不显。 */}
        {onRequestsList ?
          <button
            type="button"
            aria-pressed={tailOn}
            onClick={() => (tailOn ? dispatch({ kind: "pause" }) : goLive("resume"))}
            title={tailOn ? "自动刷新中 · 点击暂停" : "已暂停自动刷新 · 点击恢复实时跟随"}
            className={`shrink-0 border-l border-border pl-2 hover:text-foreground ${tailOn ? "text-primary" : "text-muted-foreground"}`}
          >
            {tailOn ? "▶ live" : "⏸ paused"}
          </button>
        : null}
      </div>
    </div>
  )
}
