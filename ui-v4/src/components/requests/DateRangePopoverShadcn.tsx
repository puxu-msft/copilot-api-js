import type { DateRange } from "react-day-picker"

import { DayPicker } from "react-day-picker"
import "react-day-picker/style.css"

import {
  //
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/** 当天零点(00:00:00.000)——时间范围下界。 */
function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/** 当天末毫秒(23:59:59.999)——时间范围上界。 */
function endOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

/** epoch ms → 短日期串(本地时区)。 */
function fmt(ms: number): string {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mm}-${dd}`
}

/**
 * 时间范围选择器(shadcn 侧)—— shadcn `Popover`(headless a11y/焦点/Portal)触发 react-day-picker range 日历。
 * 日界语义与 from/to epoch ms 进出与 legacy `DateRangePopover` 逐字同构;皮肤走 `.rdp-neutral`
 * (theme.css 把 `--rdp-*` 映射到中性 shadcn token,作用域化到 shadcn 树)。legacy(amber `.rdp-amber`)冻结、Z1 才删。
 */
export function DateRangePopoverShadcn({
  from,
  to,
  onChange,
}: {
  from: number | null
  to: number | null
  onChange: (from: number | null, to: number | null) => void
}) {
  const selected: DateRange | undefined =
    from === null && to === null ? undefined : { from: from === null ? undefined : new Date(from), to: to === null ? undefined : new Date(to) }

  const label = from === null && to === null ? "time range" : `${fmt(from ?? (to as number))} → ${fmt(to ?? (from as number))}`

  const handleSelect = (range: DateRange | undefined): void => {
    if (range === undefined || range.from === undefined) {
      onChange(null, null)
      return
    }
    onChange(startOfDay(range.from).getTime(), endOfDay(range.to ?? range.from).getTime())
  }

  return (
    <Popover>
      <PopoverTrigger
        aria-label="time range"
        className="inline-flex h-7 items-center gap-1 rounded-lg border border-input bg-transparent px-2.5 text-sm whitespace-nowrap text-foreground outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-muted"
      >
        {label}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="rdp-neutral w-auto p-2"
      >
        <DayPicker
          mode="range"
          selected={selected}
          onSelect={handleSelect}
        />
      </PopoverContent>
    </Popover>
  )
}
