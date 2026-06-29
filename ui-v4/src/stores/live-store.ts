import { create } from "zustand"

import type {
  //
  ActiveRequestChangedInfo,
  ActiveRequestInfo,
} from "@/types/ws"

export interface LiveState {
  byId: Record<string, ActiveRequestInfo>
}

/** 纯 reducer —— 把一个 active 事件应用到在飞集合(不可变,返回新对象)。 */
export function applyActiveEvent(state: LiveState, ev: ActiveRequestChangedInfo): LiveState {
  // 三个终态 action(completed/failed/aborted)只带 requestId,都必须离开 Live 泳道。
  // 漏掉 aborted 曾让被中止的请求永久卡在泳道里(后端 ws.ts 对 request.aborted 发 action:"aborted")。
  if (ev.action === "completed" || ev.action === "failed" || ev.action === "aborted") {
    const id = ev.requestId ?? ev.request?.id
    if (id === undefined || !(id in state.byId)) return state
    const { [id]: _removed, ...rest } = state.byId
    return { byId: rest }
  }
  // created / state_changed
  if (!ev.request) return state
  return { byId: { ...state.byId, [ev.request.id]: ev.request } }
}

interface LiveStore extends LiveState {
  apply: (ev: ActiveRequestChangedInfo) => void
  setSnapshot: (list: Array<ActiveRequestInfo>) => void
  reset: () => void
}

export const useLiveStore = create<LiveStore>((set) => ({
  byId: {},
  apply: (ev) => set((s) => applyActiveEvent(s, ev)),
  setSnapshot: (list) => set({ byId: Object.fromEntries(list.map((r) => [r.id, r])) }),
  reset: () => set({ byId: {} }),
}))
