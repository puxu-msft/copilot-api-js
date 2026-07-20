import type {
  //
  ChipKey,
  RequestFilters,
} from "@/lib/request-filters"

import { activeChips } from "@/lib/request-filters"

/** time chip 的 key 是 from 或 to——清除时必须同时清两维。 */
function isTimeKey(k: ChipKey): boolean {
  return k === "from" || k === "to"
}

/**
 * 活动筛选 chips:每个激活维度渲染一个可关闭 pill(× + label)+ 末尾 "Clear all"。
 * 无激活维度(`activeChips` 为空)→ 返回 `null`,不占位。
 *
 * time chip(key 为 `from`/`to`)的 × **必须**走批量 `setFilters({ from: null, to: null })` 一次清两维——
 * 绝不 `clearFilter("from"); clearFilter("to")` 连调:后者因 `write` 全量重写(闭包旧 `filters`)
 * 在同一事件里互相覆盖,只清掉一个(已修复 Critical bug 的对偶)。
 */
export function RequestFilterChips({
  filters,
  clearFilter,
  clearAll,
  setFilters,
}: {
  filters: RequestFilters
  clearFilter: (k: keyof RequestFilters) => void
  clearAll: () => void
  setFilters: (patch: Partial<RequestFilters>) => void
}) {
  const chips = activeChips(filters)
  if (chips.length === 0) return null

  return (
    <div className="mono flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] px-2 py-1.5 text-[11px]">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1 border border-[var(--color-primary)] px-1.5 py-0.5 text-[var(--color-primary)]"
        >
          {chip.label}
          <button
            type="button"
            aria-label={`Remove filter ${chip.label}`}
            className="leading-none text-[var(--color-primary)] hover:text-[var(--color-text)]"
            onClick={() => (isTimeKey(chip.key) ? setFilters({ from: null, to: null }) : clearFilter(chip.key))}
          >
            ×
          </button>
        </span>
      ))}
      <button
        type="button"
        className="mono ml-1 border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-muted)] hover:text-[var(--color-text)]"
        onClick={() => clearAll()}
      >
        Clear all
      </button>
    </div>
  )
}
