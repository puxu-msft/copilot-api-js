import type { VisibilityState } from "@tanstack/react-table"

import { Button } from "@/components/ui/button"
import {
  //
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { REQUEST_COLUMNS } from "@/lib/request-columns"

interface RequestsColumnMenuShadcnProps {
  /** 列可见性(TanStack `VisibilityState`,列 id → bool);缺省未知列按可见处理。 */
  columns: VisibilityState
  /** 当前列序(含 session);菜单项按此序迭代(过滤掉 session gutter),使菜单顺序随重排同步。 */
  order: ReadonlyArray<string>
  onToggle: (id: string) => void
  onReset: () => void
}

// 列 id → 菜单标签(SSOT = REQUEST_COLUMNS;菜单项顺序由 `order` prop 决定)。
const COLUMN_LABEL: Record<string, string> = Object.fromEntries(
  REQUEST_COLUMNS.map((c) => [c.id as string, typeof c.header === "string" && c.header.length > 0 ? c.header : (c.id as string)]),
)

/**
 * Requests 列表的列可见性菜单(shadcn 侧)—— 复用 `ui/dropdown-menu` 中性原语(a11y/键盘/焦点/`menuitemcheckbox`
 * 语义由 Radix 提供)。驱动 TanStack `VisibilityState`,菜单项顺序随 `order`(列序)同步、排除 session gutter。
 * 切换某列保持菜单开(`onSelect` preventDefault),一次可翻多列。legacy `RequestsColumnMenu`(amber)冻结、Z1 才删。
 */
export function RequestsColumnMenuShadcn({ columns, order, onToggle, onReset }: RequestsColumnMenuShadcnProps) {
  const items = order.filter((id) => id !== "session").map((id) => ({ id, label: COLUMN_LABEL[id] ?? id }))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
        >
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="mono min-w-[180px]"
      >
        <div className="mb-1 flex items-center justify-between border-b border-border pb-1">
          <DropdownMenuLabel className="uppercase tracking-wider">Columns</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault()
              onReset()
            }}
            className="text-primary"
          >
            Reset
          </DropdownMenuItem>
        </div>
        {items.map((col) => (
          <DropdownMenuCheckboxItem
            key={col.id}
            checked={columns[col.id] ?? true}
            onCheckedChange={() => onToggle(col.id)}
            onSelect={(e) => e.preventDefault()}
          >
            {col.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
