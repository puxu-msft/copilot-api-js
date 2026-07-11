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
import { useRequestNeighbors } from "@/hooks/useRequestNeighbors"

/** 焦点是否落在可输入元素上(避免 Esc 打断用户输入)。 */
function isTyping(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable
}

/**
 * fork B · Requests 详情全屏页 shadcn 侧(D-shell,决策 10):整页 chrome(返回列表 shadcn Button + Esc +
 * prev/next 相邻请求翻页)+ `DetailPanelShadcn`(顶部水平 `HorizontalTabs` 7 段替竖排 sub-rail)。返回/Esc
 * 行为逐字复现 legacy(`/requests?at=<id>` replace 定位、modal 打开时让位 Esc)。prev/next 用 A 类
 * `useRequestNeighbors`(决策 5,闭环 P2 M1):据当前列表顺序算相邻 id,goPrev/goNext 导航到相邻
 * `/requests/:id`(留在详情、不回列表),并绑键盘(ArrowLeft/k → prev、ArrowRight/j → next)。
 * `data-testid=request-detail-shadcn` 供 fork B 互斥挂载守卫。本文件零设计版本标识符(读取只在 RoutePage 的 `DesignFork`)。
 */
export function RequestDetailShadcn() {
  const navigate = useNavigate()
  const { id } = useParams()

  // 相邻请求翻页(决策 5):据当前列表顺序算 prev/next id;bindKeys 开启键盘翻页(键位交用户 UX 检查)。
  const { goPrev, goNext, hasPrev, hasNext } = useRequestNeighbors(id ?? null, { bindKeys: true })

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
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={goPrev}
            disabled={!hasPrev}
            aria-label="上一条请求"
          >
            ‹ 上一条
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={goNext}
            disabled={!hasNext}
            aria-label="下一条请求"
          >
            下一条 ›
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <DetailPanelShadcn />
      </div>
    </div>
  )
}
