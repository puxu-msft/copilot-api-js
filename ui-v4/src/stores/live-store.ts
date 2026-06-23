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
  if (ev.action === "completed" || ev.action === "failed") {
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
