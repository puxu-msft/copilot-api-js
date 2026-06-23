import { useLocation } from "react-router-dom"

/**
 * 应用内 catch-all 占位 —— 未建成页面（Overview/Sessions/Models/Config 等后续 Plan）
 * 命中此处而非砸出 React Router 默认 404。导航壳保留，可继续切换。
 */
export function NotBuiltYet() {
  const { pathname } = useLocation()
  const name = pathname.replace(/^\//, "").split("/")[0] || "page"
  return (
    <div className="mono flex h-full flex-col items-start justify-center gap-2 p-6">
      <div className="text-[9px] uppercase tracking-wider text-[var(--color-muted)]">{name}</div>
      <div className="text-lg font-bold text-[var(--color-primary)]">即将推出</div>
      <div className="max-w-[60ch] text-[11px] text-[#999]">本页面在后续实现计划中交付（见 docs/plans/）。当前仅 Requests 已接线。</div>
    </div>
  )
}
