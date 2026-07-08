import type { DateRange } from "react-day-picker"

import { Popover } from "radix-ui"
import { DayPicker } from "react-day-picker"
import "react-day-picker/style.css"

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

/** epoch ms → 短日期串(本地时区);null → 占位。 */
function fmt(ms: number): string {
  const d = new Date(ms)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mm}-${dd}`
}

/**
 * 时间范围选择器:Radix `Popover`(headless a11y/焦点/Portal)触发 react-day-picker
 * range 日历。**日界语义**:选中范围的首日 → `from` = `00:00:00.000`、末日 → `to` =
 * `23:59:59.999`;仅选一天时 `to` 取同一天末毫秒(span = 86_399_999ms)。清空 → `onChange(null, null)`。
 *
 * from/to 以 epoch ms(number | null)进出;内部转 `Date` 喂 DayPicker。样式走 Terminal Amber:
 * import react-day-picker 基础 css 后,用 `.rdp-amber` 作用域把 `--rdp-*` 变量重映射到项目
 * `--color-*` token(见 docs/radix-styling.md)。Portal 内容显式 `z-50`,与 Modal 对齐。
 */
export function DateRangePopover({
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
    // 清空(去选或选中被撤销)→ 双端归 null。
    if (range === undefined || range.from === undefined) {
      onChange(null, null)
      return
    }
    // 仅选一天时 to 缺省 → 取同一天末毫秒。
    onChange(startOfDay(range.from).getTime(), endOfDay(range.to ?? range.from).getTime())
  }

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="time range"
        className="mono inline-flex items-center gap-1 border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12px] text-[var(--color-text)] outline-none data-[state=open]:text-[var(--color-primary)]"
      >
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="rdp-amber mono z-50 border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-[12px] text-[var(--color-text)] outline-none"
        >
          <DayPicker
            mode="range"
            selected={selected}
            onSelect={handleSelect}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
