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

import { LiveGroup } from "@/components/requests/LiveGroup"
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
 * 请求活动状态栏 —— **fixed 到视口的底部浮岛**(脱离子布局,挂在 AppShell,所有页面可见)。承载:
 *  1. 在途请求信息(摘要 + 点击展开分组明细面板)—— 全局显示。
 *  2. tail 暂停/恢复开关 + 「新完成待合入」CTA —— 请求**列表**专属控件(操作 History 列表的 tail/缓冲),
 *     仅在 `/requests` 列表页显示。
 * 样式(与用户敲定):四周留白通栏(`bottom-3 inset-x-3`)、中性 `--color-surface` 底、amber `--color-primary`
 * 边框、2px 圆角(破例覆盖全局 `border-radius:0!important`)、h-8、shadow-xl、通栏常驻 idle 条;
 * 配色统一 amber/中性(不用信号绿——在途状态全是 live,全站 History 的 SIGNAL_COLOR 保持不变)。
 * 展开时浮岛从底向上生长(panel 在 bar 上方,同一张卡片,`bottom-3` 锚定不动)。
 */
export function LiveDock() {
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
  // 全局浮岛下,tail/缓冲控件只在请求列表页有意义(它们操作的是 History 列表)。
  const onRequestsList = useLocation().pathname === "/requests"
  const showMerge = onRequestsList && !tailOn && bufferedCount > 0

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
    // fixed 浮岛:脱离子布局、悬浮视口底部。z-40 压过内容、让位 Modal(z-50)。2px 圆角覆盖全局锐角规则。
    <div className="livedock-island fixed inset-x-3 bottom-3 z-40 flex flex-col overflow-hidden border border-[var(--color-primary)] bg-[var(--color-surface)] shadow-xl">
      {showPanel ?
        <div className="max-h-[55vh] overflow-auto border-b border-[var(--color-border)]">
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
      {/* 恒高状态条(h-8):左侧在途摘要(展开 toggle,flex-1)+ 右侧列表专属控件。独立可点区(不嵌套 button)。 */}
      <div className="mono flex h-8 w-full shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap px-3 text-[12px] text-[var(--color-text)]">
        <button
          type="button"
          aria-expanded={showPanel}
          disabled={!active}
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap text-left disabled:text-[var(--color-muted)]"
        >
          {active ?
            <>
              <span className="shrink-0 text-[var(--color-primary)]">● {summary.count} in-flight</span>
              {summary.streaming > 0 ?
                <span className="shrink-0 text-[var(--color-primary)]">⚡{summary.streaming} streaming</span>
              : null}
              {summary.retrying > 0 ?
                <span className="shrink-0 text-[var(--color-warn)]">↻{summary.retrying} retrying</span>
              : null}
              <span className="shrink-0 text-[var(--color-muted)]">oldest {formatDuration(summary.oldestElapsedMs)}</span>
              <span className="ml-auto shrink-0 text-[var(--color-muted)]">{showPanel ? "▼" : "▲"}</span>
            </>
          : <span className="text-[var(--color-muted)]">○ idle · 0 in-flight</span>}
        </button>
        {showMerge ?
          <button
            type="button"
            onClick={() => goLive("flush")}
            title={`合入 ${bufferedCount} 条新完成请求到历史并恢复实时跟随`}
            className="shrink-0 border-l border-[var(--color-border)] pl-2 text-[var(--color-primary)] hover:text-[var(--color-text)]"
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
            className={`shrink-0 border-l border-[var(--color-border)] pl-2 ${tailOn ? "text-[var(--color-primary)] hover:text-[var(--color-text)]" : "text-[var(--color-muted)] hover:text-[var(--color-text)]"}`}
          >
            {tailOn ? "▶ live" : "⏸ paused"}
          </button>
        : null}
      </div>
    </div>
  )
}
