import {
  //
  useEffect,
  useRef,
} from "react"

import {
  //
  wsClient,
  type WsCallbacks,
} from "@/lib/ws-client"

/** 订阅 WS;latest-ref:挂载时 acquire 一个稳定 wrapper,每次事件读最新 callbacks(避免 stale 闭包)。 */
export function useWs(callbacks: WsCallbacks): void {
  const ref = useRef(callbacks)
  ref.current = callbacks
  useEffect(() => {
    const stable: WsCallbacks = {
      onEntryAdded: (s) => ref.current.onEntryAdded?.(s),
      onEntryUpdated: (s) => ref.current.onEntryUpdated?.(s),
      onStatsUpdated: (s) => ref.current.onStatsUpdated?.(s),
      onStatusChange: (c) => ref.current.onStatusChange?.(c),
      onActiveRequestChanged: (i) => ref.current.onActiveRequestChanged?.(i),
      onConnected: (i) => ref.current.onConnected?.(i),
    }
    const release = wsClient.acquire(stable)
    return release
    // wrapper 稳定(只挂载一次 acquire,ref-count 不抖);事件读 ref.current 命中最新 callbacks。
  }, [])
}
