import {
  //
  formatDuration,
  statusSignal,
  type Signal,
} from "@/lib/format"

const SIGNAL_COLOR: Record<Signal, string> = {
  ok: "var(--color-ok)",
  fail: "var(--color-fail)",
  warn: "var(--color-warn)",
  live: "var(--color-ok)",
  muted: "var(--color-muted)",
}

interface RequestRowProps {
  state: string
  model?: string
  durationMs?: number
  selected?: boolean
  live?: boolean
  onClick?: () => void
}

/** 单行请求摘要 —— 信号色状态 + 模型 + 时长(spec §4.2 列表行)。 */
export function RequestRow({ state, model, durationMs, selected, live, onClick }: RequestRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mono flex w-full items-center gap-3 border-b border-[#222] px-2 py-1 text-left text-[11px] ${
        selected ? "border-l-2 border-l-[var(--color-primary)] bg-[#3a2f1a] text-[#f0d8a8]" : "text-[#aaa]"
      }`}
    >
      <span style={{ color: SIGNAL_COLOR[statusSignal(state)] }}>
        {live ? "◐" : ""} {state}
      </span>
      <span className="text-[#cdb]">{model ?? "—"}</span>
      <span className="ml-auto text-[#888]">{durationMs === undefined ? "" : formatDuration(durationMs)}</span>
    </button>
  )
}
