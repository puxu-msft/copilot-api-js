import { useCallback } from "react"
import {
  //
  useNavigate,
  useSearchParams,
} from "react-router-dom"

import { useListStore } from "@/stores/list-store"

/**
 * 恢复实时跟随并同步清理定位锚点 —— 单一事实源,HistoryList 头部 resume 与 LiveDock 合入 CTA 共用。
 *
 * `resume`/`flush` 都把 tail 转回 on(flush 额外合入缓冲,见 list-store reducer)。二者都必须清掉 URL 的
 * `?at=` 定位参数:tailing 态不该再声明 locate(否则「跟随实时流」与「URL 锚定某条」自相矛盾,见
 * HistoryList 的 at-effect 会因残留 at 反复暂停 tail)。此前该清理只在 HistoryList 内联的 goLive 里,
 * LiveDock 的合入 CTA 走独立 dispatch 会漏清 —— 抽此 hook 消除双源与不对称。
 */
export function useGoLive(): (ev: "resume" | "flush") => void {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const dispatch = useListStore((s) => s.dispatch)
  const at = searchParams.get("at")
  return useCallback(
    (ev: "resume" | "flush") => {
      dispatch({ kind: ev })
      if (at) void navigate("/requests", { replace: true })
    },
    [dispatch, at, navigate],
  )
}
