// Requests 列表的版本化列状态 hook —— 三态(visibility / sizing / order)统一持有 +
// 单键持久化(COLUMN_STATE_KEY = v1)。新键不存在(首次 / 旧键弃用)→ 从新默认 seed；
// 读回经三个 merge 纯函数对账(未知列丢、缺失列取默认、新列补位、session 恒首)。
import type {
  //
  ColumnSizingState,
  VisibilityState,
} from "@tanstack/react-table"

import {
  //
  useCallback,
  useEffect,
  useState,
} from "react"

import {
  //
  COLUMN_STATE_KEY,
  DEFAULT_COLUMN_ORDER,
  DEFAULT_COLUMN_SIZING,
  DEFAULT_COLUMN_VISIBILITY,
  mergeColumnOrder,
  mergeColumnSizing,
  mergeColumnVisibility,
} from "@/lib/request-columns"

/** 持久化 blob 形状(v1)：三态各一段;字段皆可选(旧/部分 blob 容错,缺段 merge 回默认)。 */
interface PersistedColumnState {
  visibility?: Partial<VisibilityState>
  sizing?: Record<string, number>
  order?: Array<string>
}

interface ColumnState {
  visibility: VisibilityState
  sizing: ColumnSizingState
  order: Array<string>
}

/** 从 localStorage 读并 merge 到默认(解析失败 / storage 不可用 → 全默认 seed)。 */
function load(): ColumnState {
  let p: PersistedColumnState | null = null
  try {
    p = JSON.parse(localStorage.getItem(COLUMN_STATE_KEY) ?? "null") as PersistedColumnState | null
  } catch {
    // JSON 损坏 / storage 不可用(隐私模式)→ 保持 null,走全默认 seed,不阻塞。
  }
  return {
    visibility: mergeColumnVisibility(p?.visibility ?? null),
    sizing: mergeColumnSizing(p?.sizing ?? null),
    order: mergeColumnOrder(p?.order ?? null),
  }
}

/**
 * 单一持有者(RequestsListPage 用):三态 + 写回 effect + 受控 setter。
 * setOrder 经 mergeColumnOrder 归一(session 恒首 + 新列补位),reset 清键回默认。
 */
export function useColumnState() {
  const [state, setState] = useState<ColumnState>(load)

  useEffect(() => {
    // 写入可能抛(隐私模式 / 配额)—— 不阻塞渲染,记 warn(内部工具可观测性优先)。
    try {
      localStorage.setItem(COLUMN_STATE_KEY, JSON.stringify({ visibility: state.visibility, sizing: state.sizing, order: state.order }))
    } catch (err) {
      console.warn("[useColumnState] 持久化失败:", err)
    }
  }, [state])

  const setVisibility = useCallback(
    (u: VisibilityState | ((v: VisibilityState) => VisibilityState)) => setState((s) => ({ ...s, visibility: typeof u === "function" ? u(s.visibility) : u })),
    [],
  )
  const setSizing = useCallback(
    (u: ColumnSizingState | ((v: ColumnSizingState) => ColumnSizingState)) => setState((s) => ({ ...s, sizing: typeof u === "function" ? u(s.sizing) : u })),
    [],
  )
  const setOrder = useCallback(
    (u: Array<string> | ((v: Array<string>) => Array<string>)) =>
      setState((s) => ({ ...s, order: mergeColumnOrder(typeof u === "function" ? u(s.order) : u) })),
    [],
  )
  const toggleColumn = useCallback((id: string) => setState((s) => ({ ...s, visibility: { ...s.visibility, [id]: !(s.visibility[id] ?? true) } })), [])
  const reset = useCallback(() => {
    setState({ visibility: { ...DEFAULT_COLUMN_VISIBILITY }, sizing: { ...DEFAULT_COLUMN_SIZING }, order: [...DEFAULT_COLUMN_ORDER] })
    try {
      localStorage.removeItem(COLUMN_STATE_KEY)
    } catch {
      // removeItem 失败(storage 不可用)无害:下一次 setState 的写回 effect 会重建键。
    }
  }, [])

  return { ...state, setVisibility, setSizing, setOrder, toggleColumn, reset }
}
