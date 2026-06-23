import { useEffect } from "react"

import {
  //
  wsClient,
  type WsCallbacks,
} from "@/lib/ws-client"

/** 订阅 WS;StrictMode 下 acquire/release 配对，模块单例复用同一连接。 */
export function useWs(callbacks: WsCallbacks): void {
  useEffect(() => {
    const release = wsClient.acquire(callbacks)
    return release
    // callbacks 由调用方用 useMemo 稳定;此处刻意只在挂载/卸载 acquire/release。
    // (本仓库 eslint 未启用 react-hooks 插件,故无 exhaustive-deps 规则需 disable。)
  }, [])
}
