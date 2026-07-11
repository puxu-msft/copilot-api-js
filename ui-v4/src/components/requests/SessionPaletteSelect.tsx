import { Select } from "radix-ui"

import {
  //
  ITEM_CLASS,
  TRIGGER_CLASS,
} from "@/components/shared/FilterSelect"
import { SESSION_PALETTES } from "@/lib/session-color"

/** Session 色板选择器 —— Radix Select，选项 = SESSION_PALETTES（无 all 哨兵）。纯本地设置。 */
export function SessionPaletteSelect({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  return (
    <Select.Root
      value={value}
      onValueChange={onChange}
    >
      <Select.Trigger
        aria-label="session 色板"
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
            {SESSION_PALETTES.map((p) => (
              <Select.Item
                key={p.name}
                value={p.name}
                className={ITEM_CLASS}
              >
                <Select.ItemText>{p.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}
