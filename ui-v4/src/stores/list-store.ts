import { create } from "zustand"

export interface ListState {
  /** 自动跟最新(tail-on);定位/上滚自动转 paused。 */
  tailOn: boolean
  /** paused 期间到达的新完成条目 id(去重,FIFO),点横幅/resume 时合入。 */
  bufferedIds: Array<string>
}

export const initialListState: ListState = { tailOn: true, bufferedIds: [] }

export type ListEvent =
  | { kind: "incoming"; id: string }
  | { kind: "flush" }
  | { kind: "resume" }
  | { kind: "locate" }
  | { kind: "scroll-up" }
  | { kind: "reset" }

/**
 * 纯 reducer —— 见 spec §4.2(Live 泳道 / 缓冲横幅 + tail)。
 * 选中/定位的真值现由 URL(列表 `?at=<id>`、详情 `/requests/:id`)承载,不再存 store;
 * store 只管 tail 跟随与缓冲。
 */
export function reduceListEvent(state: ListState, ev: ListEvent): ListState {
  switch (ev.kind) {
    case "incoming": {
      if (state.tailOn) return state // tail-on:调用方直接 prepend,不缓冲
      if (state.bufferedIds.includes(ev.id)) return state
      return { ...state, bufferedIds: [...state.bufferedIds, ev.id] }
    }
    case "flush":
    case "resume": {
      return { ...state, tailOn: true, bufferedIds: [] }
    }
    case "locate": {
      // 定位到具体条目(点行进详情 / URL 带 ?at=)→ 暂停 tail,避免新条目把定位行挤走。
      // 幂等:已暂停则返回原引用,避免 at-effect 重复触发时产生无谓 re-render。
      return state.tailOn ? { ...state, tailOn: false } : state
    }
    case "scroll-up": {
      return state.tailOn ? { ...state, tailOn: false } : state
    }
    case "reset": {
      return initialListState
    }
    default: {
      return state
    }
  }
}

interface ListStore extends ListState {
  dispatch: (ev: ListEvent) => void
}

export const useListStore = create<ListStore>((set) => ({
  ...initialListState,
  dispatch: (ev) => set((s) => reduceListEvent(s, ev)),
}))
