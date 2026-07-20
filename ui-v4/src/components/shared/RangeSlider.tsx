import { Slider } from "radix-ui"

/** Terminal Amber 双滑块范围选择器（Radix Slider）。value=null 表示满量程。 */
export function RangeSlider({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string
  min: number
  max: number
  value: [number, number] | null
  onChange: (v: [number, number] | null) => void
}) {
  const current: [number, number] = value ?? [min, max]
  const step = max - min > 20 ? 0.5 : 0.1
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] uppercase text-[var(--color-muted)]">{label}:</span>
      <span className="text-[11px] text-[var(--color-text)]">
        {current[0]}–{current[1]}
      </span>
      <Slider.Root
        className="relative flex h-4 w-32 touch-none items-center"
        min={min}
        max={max}
        step={step}
        value={current}
        aria-label={label}
        onValueChange={([a, b]) => onChange(a <= min && b >= max ? null : [a, b])}
      >
        <Slider.Track className="relative h-[3px] grow bg-[var(--color-border)]">
          <Slider.Range className="absolute h-full bg-[var(--color-primary)]" />
        </Slider.Track>
        <Slider.Thumb className="block h-3 w-3 border border-[var(--color-primary)] bg-[var(--color-surface)]" />
        <Slider.Thumb className="block h-3 w-3 border border-[var(--color-primary)] bg-[var(--color-surface)]" />
      </Slider.Root>
    </div>
  )
}
