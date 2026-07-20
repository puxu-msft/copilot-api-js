import { Search } from "lucide-react"

import { DesignVersionToggle } from "@/components/shell/DesignVersionToggle"
import { Input } from "@/components/ui/input"
import { useUiStore } from "@/stores/ui-store"

/**
 * shadcn shell 骨架 · TopBar。最小:搜索占位 + WS 状态 + designVersion 切换按钮。
 * C6 只搭机制;打磨留后续 plan。中性语义 token(neutral preset)。
 *
 * 注:读 `wsConnected`(WS 连接态)不违反结构隔离 —— 隔离约束的是 `designVersion`(切换开关),
 * `wsConnected` 是常驻 live 状态、两版都读。designVersion 只在 DesignVersionToggle 内读。
 */
export function ShadcnTopBar(): React.ReactElement {
  const wsConnected = useUiStore((s) => s.wsConnected)
  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-8 pl-8"
          aria-label="搜索请求 / session / 模型"
          placeholder="搜索请求 / session / 模型…(Plan 07)"
        />
      </div>
      <span className={`px-2 text-sm ${wsConnected ? "text-primary" : "text-destructive"}`}>● {wsConnected ? "WS connected" : "WS offline"}</span>
      <DesignVersionToggle />
    </div>
  )
}
