import {
  //
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SESSION_PALETTES } from "@/lib/session-color"

/**
 * Session 色板选择器(shadcn 侧)—— 复用 `ui/select` 中性原语,选项 = `SESSION_PALETTES`(共用数据层,A)。
 * 纯本地设置。legacy `SessionPaletteSelect`(amber)冻结、Z1 才删。
 */
export function SessionPaletteSelectShadcn({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  return (
    <Select
      value={value}
      onValueChange={onChange}
    >
      <SelectTrigger
        size="sm"
        aria-label="session 色板"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SESSION_PALETTES.map((p) => (
          <SelectItem
            key={p.name}
            value={p.name}
          >
            {p.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
