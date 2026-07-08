import { create } from "zustand"

import type {
  //
  ActiveRequestChangedInfo,
  ActiveRequestInfo,
} from "@/types/ws"

/** 合并到在途条目上的瞬时重试态(来自 attempt_failed)。 */
export interface RetryInfo {
  attempt: number
  strategy?: string
  willRetry: boolean
  nextStrategy?: string
  waitMs: number
  learning?: boolean
}
export interface FeatureApplied {
  feature: string
  detail?: Record<string, unknown>
}
/** 在途条目 = wire 快照 + 前端累积的瞬时遥测(retry 覆盖式、features 追加式)。 */
export type LiveEntry = ActiveRequestInfo & { retry?: RetryInfo; features?: Array<FeatureApplied> }

export interface LiveState {
  byId: Record<string, LiveEntry>
}

/** 纯 reducer —— 把一个 active 事件应用到在飞集合(不可变,返回新对象)。 */
export function applyActiveEvent(state: LiveState, ev: ActiveRequestChangedInfo): LiveState {
  // 终态(completed/failed/aborted)只带 requestId,必须离开在途集。
  // 漏掉 aborted 曾让被中止的请求永久卡在泳道里(后端 ws.ts 对 request.aborted 发 action:"aborted")。
  if (ev.action === "completed" || ev.action === "failed" || ev.action === "aborted") {
    if (!(ev.requestId in state.byId)) return state
    const { [ev.requestId]: _removed, ...rest } = state.byId
    return { byId: rest }
  }
  // attempt_failed:合并实时重试遥测(id 不存在则 no-op)。
  if (ev.action === "attempt_failed") {
    if (!(ev.requestId in state.byId)) return state
    const prev = state.byId[ev.requestId]
    const retry: RetryInfo = { attempt: ev.attempt, willRetry: ev.willRetry, waitMs: ev.waitMs }
    if (ev.strategy !== undefined) retry.strategy = ev.strategy
    if (ev.nextStrategy !== undefined) retry.nextStrategy = ev.nextStrategy
    if (ev.learning !== undefined) retry.learning = ev.learning
    return { byId: { ...state.byId, [ev.requestId]: { ...prev, retry } } }
  }
  // feature_applied:追加特性(id 不存在则 no-op)。
  if (ev.action === "feature_applied") {
    if (!(ev.requestId in state.byId)) return state
    const prev = state.byId[ev.requestId]
    const features = [...(prev.features ?? []), { feature: ev.feature, ...(ev.detail !== undefined && { detail: ev.detail }) }]
    return { byId: { ...state.byId, [ev.requestId]: { ...prev, features } } }
  }
  // created / state_changed:携完整 request。state_changed 视作新一轮 attempt 起点,清陈旧 retry;
  // features 跨事件保留(累积)。
  const prev = ev.request.id in state.byId ? state.byId[ev.request.id] : undefined
  const merged: LiveEntry = { ...ev.request, ...(prev?.features !== undefined && { features: prev.features }) }
  return { byId: { ...state.byId, [ev.request.id]: merged } }
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
