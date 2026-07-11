import {
  //
  useCallback,
  useEffect,
  useMemo,
} from "react"
import { useNavigate } from "react-router-dom"

import { useHistoryInfinite } from "@/hooks/useHistoryInfinite"
import { useRequestFilters } from "@/hooks/useRequestFilters"

/** 相邻请求 id(据当前列表顺序):`prevId` = 上一条(列表更新/更靠上),`nextId` = 下一条(更旧/更靠下)。 */
export interface Neighbors {
  prevId: string | null
  nextId: string | null
}

/**
 * 纯计算:给定当前列表顺序 `orderedIds` 与当前条目 `currentId`,算相邻 prev/next id。
 * `currentId` 为 null 或不在序内(已淘汰/深链未加载)→ 双端 null。边界(首/末条)对应端为 null。
 * 方向与列表 roving 一致:next = 数组后一位(ArrowDown 方向,列表 newest-first ⟹ 更旧),prev = 前一位。
 */
export function neighborIds(orderedIds: ReadonlyArray<string>, currentId: string | null): Neighbors {
  if (currentId === null) return { prevId: null, nextId: null }
  const i = orderedIds.indexOf(currentId)
  if (i === -1) return { prevId: null, nextId: null }
  return {
    prevId: i > 0 ? orderedIds[i - 1] : null,
    nextId: i < orderedIds.length - 1 ? orderedIds[i + 1] : null,
  }
}

/** 焦点是否落在可输入元素上(避免在输入框内按 j/k/方向键误触翻页)。 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable
}

/**
 * 请求相邻导航 hook —— **design-agnostic(A 类,零设计版本标识符/颜色)**,shadcn 详情页 / 列表复用。
 *
 * 据当前 URL 筛选(`useRequestFilters`)复用同一 `useHistoryInfinite` 查询(react-query 共享缓存,
 * 与列表同 queryKey ⟹ 不额外拉取)得列表顺序,算 `currentId` 的相邻 prev/next id。
 * `goPrev`/`goNext` 导航到 `/requests/:id`(**留在详情、不回列表**,决策 5)。
 * `bindKeys`(默认关):挂 document keydown,`ArrowLeft`/`k` → prev、`ArrowRight`/`j` → next
 * (isTyping + 修饰键守卫);消费方(P3 详情 chrome)开启即得键盘翻页。键位是**交用户 UX 检查项**。
 */
export function useRequestNeighbors(
  currentId: string | null,
  opts?: { bindKeys?: boolean },
): Neighbors & {
  goPrev: () => void
  goNext: () => void
  hasPrev: boolean
  hasNext: boolean
} {
  const navigate = useNavigate()
  const { filters } = useRequestFilters()
  const { entries } = useHistoryInfinite(filters)
  const orderedIds = useMemo(() => entries.map((e) => e.id), [entries])
  const { prevId, nextId } = useMemo(() => neighborIds(orderedIds, currentId), [orderedIds, currentId])

  const goPrev = useCallback(() => {
    if (prevId !== null) void navigate(`/requests/${prevId}`)
  }, [navigate, prevId])
  const goNext = useCallback(() => {
    if (nextId !== null) void navigate(`/requests/${nextId}`)
  }, [navigate, nextId])

  const bindKeys = opts?.bindKeys ?? false
  useEffect(() => {
    if (!bindKeys) return
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.key === "ArrowLeft" || e.key === "k") {
        if (prevId === null) return
        e.preventDefault()
        goPrev()
      } else if (e.key === "ArrowRight" || e.key === "j") {
        if (nextId === null) return
        e.preventDefault()
        goNext()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [bindKeys, prevId, nextId, goPrev, goNext])

  return { prevId, nextId, goPrev, goNext, hasPrev: prevId !== null, hasNext: nextId !== null }
}
