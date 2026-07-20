import {
  //
  Button,
} from "@/components/ui/button"
import {
  //
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  //
  MODEL_COLUMNS,
  type ModelColumnKey,
  type ModelColumnVisibility,
} from "@/lib/model-columns"

interface ModelsColumnMenuShadcnProps {
  columns: ModelColumnVisibility
  onToggle: (key: ModelColumnKey) => void
  onReset: () => void
}

/**
 * Models 列表的列可见性菜单(shadcn 侧)—— 复用 `ui/dropdown-menu` 中性原语(a11y/键盘/焦点/
 * `menuitemcheckbox` 语义由 Radix 提供),驱动共享 `MODEL_COLUMNS`(SSOT)。切换某列保持菜单开
 * (`onSelect` preventDefault),一次可翻多列。legacy `ModelsColumnMenu`(amber)冻结、Z1 才删。
 */
export function ModelsColumnMenuShadcn({ columns, onToggle, onReset }: ModelsColumnMenuShadcnProps) {
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
        {MODEL_COLUMNS.map((col) => (
          <DropdownMenuCheckboxItem
            key={col.key}
            checked={columns[col.key]}
            onCheckedChange={() => onToggle(col.key)}
            onSelect={(e) => e.preventDefault()}
          >
            {col.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
