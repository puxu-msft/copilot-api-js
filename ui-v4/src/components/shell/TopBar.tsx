import { DesignVersionToggle } from "@/components/shell/DesignVersionToggle"
import { useUiStore } from "@/stores/ui-store"

export function TopBar() {
  const wsConnected = useUiStore((s) => s.wsConnected)
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5">
      <input
        className="mono flex-1 border border-[var(--color-border)] bg-[#0f0f12] px-2 py-1 text-[14px] text-[#888]"
        placeholder="⌕ 搜索请求 / session / 模型…(Plan 07)"
      />
      <span className={`mono px-2 py-0.5 text-[13px] ${wsConnected ? "text-[var(--color-ok)]" : "text-[var(--color-fail)]"}`}>
        ● {wsConnected ? "WS connected" : "WS offline"}
      </span>
      {/* designVersion 切换(C6):切到 shadcn 树。DesignVersionToggle 内部读 designVersion,TopBar 本体不含。 */}
      <DesignVersionToggle />
    </div>
  )
}
