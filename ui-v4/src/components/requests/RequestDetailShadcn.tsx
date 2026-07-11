import {
  //
  useCallback,
  useEffect,
} from "react"
import {
  //
  useNavigate,
  useParams,
} from "react-router-dom"

import { DetailPanelShadcn } from "@/components/detail/DetailPanelShadcn"
import { Button } from "@/components/ui/button"

/** 焦点是否落在可输入元素上(避免 Esc 打断用户输入)。 */
function isTyping(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable
}

/**
 * fork B · Requests 详情全屏页 shadcn 侧(D-shell,决策 10):整页 chrome(返回列表 shadcn Button + Esc)
 * + `DetailPanelShadcn`(顶部水平 `HorizontalTabs` 7 段替竖排 sub-rail)。返回/Esc 行为逐字复现 legacy
 * (`/requests?at=<id>` replace 定位、modal 打开时让位 Esc)。prev/next 相邻导航在后续 commit 接入。
 * `data-testid=request-detail-shadcn` 供 fork B 互斥挂载守卫。本文件零设计版本标识符(读取只在 RoutePage 的 `DesignFork`)。
 */
export function RequestDetailShadcn() {
  const navigate = useNavigate()
  const { id } = useParams()

  // 返回列表并把 URL 定位到当前条目(`/requests?at=<id>`,replace 语义,同 legacy)。
  const backToList = useCallback(() => {
    void navigate(id ? `/requests?at=${encodeURIComponent(id)}` : "/requests", { replace: true })
  }, [navigate, id])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isTyping()) return
      // 有 modal(BlockJsonModal 等)打开时,让它先吃掉 Esc —— 避免一次按键既关弹窗又返回列表。
      if (document.querySelector('[role="dialog"]')) return
      backToList()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [backToList])

  return (
    <div
      data-testid="request-detail-shadcn"
      className="flex h-full min-h-0 flex-col text-foreground"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={backToList}
        >
          ‹ 返回列表
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <DetailPanelShadcn />
      </div>
    </div>
  )
}
