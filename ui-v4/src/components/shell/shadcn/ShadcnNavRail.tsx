import {
  //
  Activity,
  Boxes,
  FileJson,
  GraduationCap,
  LayoutDashboard,
  MessagesSquare,
  Settings2,
  type LucideIcon,
} from "lucide-react"
import { NavLink } from "react-router-dom"

import { cn } from "@/lib/utils"

/** shadcn 侧导航项:加宽栏 + lucide 图标(决策 11)。与 legacy NavRail 同一批路由,互斥挂载。 */
const ITEMS: ReadonlyArray<{ to: string; label: string; icon: LucideIcon }> = [
  { to: "/overview", label: "Overview", icon: LayoutDashboard },
  { to: "/requests", label: "Requests", icon: Activity },
  { to: "/sessions", label: "Sessions", icon: MessagesSquare },
  { to: "/models", label: "Models", icon: Boxes },
  { to: "/config", label: "Config", icon: Settings2 },
  { to: "/learned", label: "Learned", icon: GraduationCap },
  { to: "/tools/json", label: "JSON decode", icon: FileJson },
]

/**
 * shadcn shell 骨架 · 加宽 NavRail(~208px)+ lucide 图标(RFC 决策 11)。
 * C6 只搭机制 + 最小骨架;逐页 chrome 打磨留后续 plan。用中性语义 token(neutral preset),
 * 圆角随 `--radius`(C4 作用域化后 shadcn 树按 token 出圆角)。
 */
export function ShadcnNavRail(): React.ReactElement {
  return (
    <nav className="flex w-52 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-2 text-sidebar-foreground">
      <div className="flex items-center gap-2 px-2 py-2 text-sm font-semibold text-sidebar-primary">
        <Boxes className="size-4" /> copilot-api
      </div>
      {ITEMS.map((it) => {
        const Icon = it.icon
        return (
          <NavLink
            key={it.to}
            to={it.to}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                isActive ?
                  "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              )
            }
          >
            <Icon className="size-4 shrink-0" />
            {it.label}
          </NavLink>
        )
      })}
    </nav>
  )
}
