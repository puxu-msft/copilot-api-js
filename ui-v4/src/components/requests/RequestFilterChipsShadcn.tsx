import type {
  //
  ChipKey,
  RequestFilters,
} from "@/lib/request-filters"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { activeChips } from "@/lib/request-filters"

/** time chip 的 key 是 from 或 to——清除时必须同时清两维。 */
function isTimeKey(k: ChipKey): boolean {
  return k === "from" || k === "to"
}

/**
 * 活动筛选 chips(shadcn 侧)—— 每个激活维度渲染一个可关闭 `Badge`(× + label)+ 末尾 "Clear all"。
 * 无激活维度 → 返回 `null`。time chip 的 × 走批量 `setFilters({ from: null, to: null })`(逐字同构 legacy 的
 * 一次清两维语义,避免连调互相覆盖)。legacy `RequestFilterChips`(amber)冻结、Z1 才删。
 */
export function RequestFilterChipsShadcn({
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
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5 text-xs">
      {chips.map((chip) => (
        <Badge
          key={chip.key}
          variant="outline"
          className="gap-1 border-primary text-primary"
        >
          {chip.label}
          <button
            type="button"
            aria-label={`Remove filter ${chip.label}`}
            className="leading-none hover:text-foreground"
            onClick={() => (isTimeKey(chip.key) ? setFilters({ from: null, to: null }) : clearFilter(chip.key))}
          >
            ×
          </button>
        </Badge>
      ))}
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="ml-1"
        onClick={() => clearAll()}
      >
        Clear all
      </Button>
    </div>
  )
}
