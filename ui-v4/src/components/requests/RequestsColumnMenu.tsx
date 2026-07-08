import type { VisibilityState } from "@tanstack/react-table"

import { DropdownMenu } from "radix-ui"

import { REQUEST_COLUMNS } from "@/lib/request-columns"

interface RequestsColumnMenuProps {
  /** 列可见性(TanStack `VisibilityState`,列 id → bool);缺省未知列按可见处理。 */
  columns: VisibilityState
  onToggle: (id: string) => void
  onReset: () => void
}

// 菜单项标签取列 header(全为字符串);非字符串 header 回退到列 id。SSOT = REQUEST_COLUMNS。
const COLUMN_MENU_ITEMS: ReadonlyArray<{ id: string; label: string }> = REQUEST_COLUMNS.map((c) => ({
  id: c.id as string,
  label: typeof c.header === "string" ? c.header : (c.id as string),
}))

/**
 * Requests 列表的列可见性菜单 —— 镜像 `ModelsColumnMenu`,建于 Radix `DropdownMenu`(headless):
 * 点击外部关闭、Escape、键盘导航、焦点管理、`menuitemcheckbox` 语义皆由 Radix 提供
 * (见 docs/radix-styling.md)。驱动 TanStack `VisibilityState`。
 *
 * 切换某列保持菜单开(`onSelect` preventDefault),一次可翻多列。
 */
export function RequestsColumnMenu({ columns, onToggle, onReset }: RequestsColumnMenuProps) {
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
          {COLUMN_MENU_ITEMS.map((col) => (
            <DropdownMenu.CheckboxItem
              key={col.id}
              checked={columns[col.id] ?? true}
              onCheckedChange={() => onToggle(col.id)}
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
