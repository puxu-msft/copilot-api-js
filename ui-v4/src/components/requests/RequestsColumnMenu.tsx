import type { VisibilityState } from "@tanstack/react-table"

import { DropdownMenu } from "radix-ui"

import { REQUEST_COLUMNS } from "@/lib/request-columns"

interface RequestsColumnMenuProps {
  /** 列可见性(TanStack `VisibilityState`,列 id → bool);缺省未知列按可见处理。 */
  columns: VisibilityState
  /** 当前列序(含 session);菜单项按此序迭代(过滤掉 session gutter),使菜单顺序随重排同步。 */
  order: ReadonlyArray<string>
  onToggle: (id: string) => void
  onReset: () => void
}

// 列 id → 菜单标签(取列 header 字符串,非字符串回退到 id)。SSOT = REQUEST_COLUMNS;菜单项顺序由 `order` prop 决定。
const COLUMN_LABEL: Record<string, string> = Object.fromEntries(
  REQUEST_COLUMNS.map((c) => [c.id as string, typeof c.header === "string" && c.header.length > 0 ? c.header : (c.id as string)]),
)

/**
 * Requests 列表的列可见性菜单 —— 镜像 `ModelsColumnMenu`,建于 Radix `DropdownMenu`(headless):
 * 点击外部关闭、Escape、键盘导航、焦点管理、`menuitemcheckbox` 语义皆由 Radix 提供
 * (见 docs/radix-styling.md)。驱动 TanStack `VisibilityState`,菜单项顺序随 `order`(列序)同步、
 * 排除 session gutter(无标签、不可切显隐)。
 *
 * 切换某列保持菜单开(`onSelect` preventDefault),一次可翻多列。
 */
export function RequestsColumnMenu({ columns, order, onToggle, onReset }: RequestsColumnMenuProps) {
  // 按当前列序迭代(排除 session gutter);未知/缺标签 id 回退到 id 自身。
  const items = order.filter((id) => id !== "session").map((id) => ({ id, label: COLUMN_LABEL[id] ?? id }))
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
          {items.map((col) => (
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
