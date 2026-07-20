import { Select } from "radix-ui"

export const TRIGGER_CLASS =
  "mono inline-flex items-center gap-1 border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[12px] text-[var(--color-text)] outline-none data-[state=open]:text-[var(--color-primary)]"
export const ITEM_CLASS =
  "mono cursor-pointer px-2 py-1 text-[12px] text-[var(--color-text)] outline-none data-[highlighted]:bg-[#3a2f1a] data-[highlighted]:text-[var(--color-primary)] data-[state=checked]:text-[var(--color-primary)]"

/** Radix has no empty-string item value; use this sentinel for the "all/any" option. */
export const ALL = "__all__"

/**
 * One filter dropdown on Radix `Select` (headless). Maps the "all/any" choice to
 * `null` via a sentinel (Radix forbids empty-string item values). Styled to
 * Terminal Amber (see docs/radix-styling.md).
 */
export function FilterSelect({
  label,
  value,
  onChange,
  allLabel,
  options,
}: {
  label: string
  value: string | null
  onChange: (value: string | null) => void
  allLabel: string
  options: ReadonlyArray<{ value: string; label: string }>
}) {
  return (
    <Select.Root
      value={value ?? ALL}
      onValueChange={(v) => onChange(v === ALL ? null : v)}
    >
      <Select.Trigger
        aria-label={label}
        className={TRIGGER_CLASS}
      >
        <Select.Value />
        <Select.Icon>▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="mono z-50 border border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <Select.Viewport>
            <Select.Item
              value={ALL}
              className={ITEM_CLASS}
            >
              <Select.ItemText>{allLabel}</Select.ItemText>
            </Select.Item>
            {options.map((o) => (
              <Select.Item
                key={o.value}
                value={o.value}
                className={ITEM_CLASS}
              >
                <Select.ItemText>{o.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
