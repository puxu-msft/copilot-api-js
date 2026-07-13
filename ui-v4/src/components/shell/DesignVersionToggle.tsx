import {
  //
  Palette,
  Terminal,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { useUiStore } from "@/stores/ui-store"

/**
 * designVersion 切换控件(C6,替代 C0 删除的 theme 按钮)。两版 chrome 的 TopBar 各嵌一个,
 * 使切换双向可达(amber-legacy ⇄ shadcn)。
 *
 * 落点:`shell/` 属 D-chrome,允许读 `designVersion`(Global Constraint 5 grep 守卫不含 shell/)。
 * 切换只调 `setDesignVersion`(store 变更,非导航)→ URL 不变、react-query 缓存 + live-store 跨切换存活。
 */
export function DesignVersionToggle(): React.ReactElement {
  const designVersion = useUiStore((s) => s.designVersion)
  const setDesignVersion = useUiStore((s) => s.setDesignVersion)
  const isShadcn = designVersion === "shadcn"
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid="design-version-toggle"
      title={isShadcn ? "当前 shadcn 设计 · 点击切回 Terminal Amber" : "当前 Terminal Amber · 点击切到 shadcn 设计"}
      onClick={() => setDesignVersion(isShadcn ? "amber-legacy" : "shadcn")}
    >
      {isShadcn ?
        <>
          <Palette /> shadcn
        </>
      : <>
          <Terminal /> amber
        </>
      }
    </Button>
  )
}
