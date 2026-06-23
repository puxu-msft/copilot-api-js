import { create } from "zustand"

export interface ListState {
  /** 自动跟最新(tail-on);选中/上滚自动转 paused。 */
  tailOn: boolean
  /** paused 期间到达的新完成条目 id(去重,FIFO),点横幅/resume 时合入。 */
  bufferedIds: Array<string>
  /** URL 驱动的选中 id 的本地镜像(用于粘滞高亮;真值仍以路由为准)。 */
  selectedId: string | null
}

export const initialListState: ListState = { tailOn: true, bufferedIds: [], selectedId: null }

export type ListEvent =
  | { kind: "incoming"; id: string }
  | { kind: "flush" }
  | { kind: "resume" }
  | { kind: "select"; id: string }
  | { kind: "scroll-up" }
  | { kind: "reset" }

/** 纯 reducer —— 见 spec §4.2(三件套:Live 泳道/缓冲横幅/选中粘滞 + tail)。 */
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
    case "select": {
      return { ...state, tailOn: false, selectedId: ev.id }
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
