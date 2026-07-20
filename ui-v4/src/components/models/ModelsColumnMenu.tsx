import { DropdownMenu } from "radix-ui"

import {
  //
  MODEL_COLUMNS,
  type ModelColumnKey,
  type ModelColumnVisibility,
} from "@/lib/model-columns"

interface ModelsColumnMenuProps {
  columns: ModelColumnVisibility
  onToggle: (key: ModelColumnKey) => void
  onReset: () => void
}

/**
 * Column visibility menu, built on Radix `DropdownMenu` (headless) — Radix
 * provides click-outside dismissal, Escape, keyboard menu navigation, focus
 * management, and `menuitemcheckbox` semantics that the previous `<details>`
 * version lacked. Styled to Terminal Amber (see docs/radix-styling.md).
 *
 * Toggling a column keeps the menu open (`onSelect` preventDefault) so several
 * columns can be flipped in one visit — matching the old always-open `<details>`.
 */
export function ModelsColumnMenu({ columns, onToggle, onReset }: ModelsColumnMenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="mono cursor-pointer border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-text)] outline-none hover:text-[var(--color-primary)] data-[state=open]:text-[var(--color-primary)]">
        Columns
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="mono z-50 min-w-[180px] border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-[12px]"
        >
          <div className="mb-1 flex items-center justify-between border-b border-[var(--color-border)] pb-1">
            <DropdownMenu.Label className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">Columns</DropdownMenu.Label>
            <DropdownMenu.Item
              onSelect={(e) => {
                e.preventDefault()
                onReset()
              }}
              className="cursor-pointer text-[11px] text-[var(--color-primary)] outline-none"
            >
              Reset
            </DropdownMenu.Item>
          </div>
          {MODEL_COLUMNS.map((col) => (
            <DropdownMenu.CheckboxItem
              key={col.key}
              checked={columns[col.key]}
              onCheckedChange={() => onToggle(col.key)}
              onSelect={(e) => e.preventDefault()}
              className="flex cursor-pointer items-center gap-2 py-0.5 outline-none data-[highlighted]:bg-[#3a2f1a]"
            >
              <span className="inline-flex w-3 justify-center text-[var(--color-primary)]">
                <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator>
              </span>
              <span>{col.label}</span>
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
