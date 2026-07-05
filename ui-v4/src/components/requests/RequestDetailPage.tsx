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

import { DetailPanel } from "@/components/detail/DetailPanel"

/** 焦点是否落在可输入元素上(避免 Esc 打断用户输入)。 */
function isTyping(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable
}

/** Requests 详情全屏页(Plan 08 §2):返回列表(定位回被查看条目)+ DetailPanel 占满主内容区。 */
export function RequestDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams()

  // 返回列表并把 URL 定位到当前条目(`/requests?at=<id>`):
  // - replace 语义:替换掉当前详情历史项,不新增回退项、Forward 不复活已关详情(符合"不污染 back 栈")。
  // - 目标恒为列表(与"返回列表"标签一致);想回上一来源(如会话页)仍可用浏览器"后退"。
  // - id 取自 URL(useParams)而非导航 state → 深链/刷新直达 `/requests/:id` 时同样成立。
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
    <div className="flex h-full min-h-0 flex-col">
      <button
        type="button"
        onClick={backToList}
        className="mono shrink-0 border-b border-[var(--color-border)] px-2 py-1 text-left text-[12px] text-[var(--color-primary)]"
      >
        ‹ 返回列表
      </button>
      <div className="flex min-h-0 flex-1 flex-col">
        <DetailPanel />
      </div>
    </div>
  )
}
