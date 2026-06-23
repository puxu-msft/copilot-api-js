import type {
  //
  EntrySummary,
  HistoryStats,
} from "@/types"
import type {
  //
  ActiveRequestChangedInfo,
  ConnectedInfo,
} from "@/types/ws"

export interface WsCallbacks {
  onEntryAdded?: (s: EntrySummary) => void
  onEntryUpdated?: (s: EntrySummary) => void
  onStatsUpdated?: (s: HistoryStats) => void
  onStatusChange?: (connected: boolean) => void
  onActiveRequestChanged?: (info: ActiveRequestChangedInfo) => void
  onConnected?: (info: ConnectedInfo) => void
}

interface WsClientOptions {
  url: string
  /** 注入 socket 工厂便于测试；默认 new WebSocket(url)。 */
  socketFactory?: (url: string) => WebSocket
}

/**
 * WSClient —— React 树外的模块单例 + 引用计数(spec §2)。
 * acquire() 返回 release fn；首个 acquire 建连，末个 release 断连。
 * 规避 StrictMode 双挂载/HMR 连接泄漏。重连:指数退避 1s→30s + ±25% jitter
 * (逐字移植自 ui/src/api/ws.ts:186-196)。
 */
export function createWsClient(options: WsClientOptions) {
  const make = options.socketFactory ?? ((u: string) => new WebSocket(u))
  let socket: WebSocket | null = null
  let refCount = 0
  let intentionalClose = false
  let reconnectDelay = 1000
  const maxReconnectDelay = 30_000
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  const callbackSets = new Set<WsCallbacks>()

  function connect() {
    if (socket) return
    intentionalClose = false
    // 捕获本次 socket 实例，守卫每个 handler：StrictMode 同步 churn 下旧 socket 的
    // 异步事件(尤其 close)在新 socket 接管后才 fire，必须忽略以免 clobber 活引用 + spurious 重连。
    const thisSocket = make(options.url)
    socket = thisSocket
    thisSocket.addEventListener("open", () => {
      if (socket !== thisSocket) return
      reconnectDelay = 1000
      for (const cb of callbackSets) cb.onStatusChange?.(true)
    })
    thisSocket.addEventListener("message", (ev: MessageEvent) => {
      if (socket !== thisSocket) return
      dispatch(ev)
    })
    thisSocket.addEventListener("close", () => {
      if (socket !== thisSocket) return // 已有更新的 socket 接管 —— 忽略 stale close
      for (const cb of callbackSets) cb.onStatusChange?.(false)
      socket = null
      if (!intentionalClose && refCount > 0) scheduleReconnect()
    })
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    const jittered = reconnectDelay * (0.75 + Math.random() * 0.5)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, jittered)
    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay)
  }

  function dispatch(ev: MessageEvent) {
    let msg: { type?: string; data?: unknown }
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    // 完整 topic 路由在 Plan 02 扩展;此处先连通 entry/stats 三类。
    for (const cb of callbackSets) {
      switch (msg.type) {
        case "entry_added": {
          cb.onEntryAdded?.(msg.data as EntrySummary)
          break
        }
        case "entry_updated": {
          cb.onEntryUpdated?.(msg.data as EntrySummary)
          break
        }
        case "stats_updated": {
          cb.onStatsUpdated?.(msg.data as HistoryStats)
          break
        }
        case "active_request_changed": {
          cb.onActiveRequestChanged?.(msg.data as ActiveRequestChangedInfo)
          break
        }
        case "connected": {
          cb.onConnected?.(msg.data as ConnectedInfo)
          break
        }
        default: {
          // 其余 topic（Plan 02 扩展）暂不路由。
          break
        }
      }
    }
  }

  return {
    acquire(cb: WsCallbacks = {}): () => void {
      callbackSets.add(cb)
      refCount++
      if (refCount === 1) connect()
      return () => {
        callbackSets.delete(cb)
        refCount--
        if (refCount === 0) {
          intentionalClose = true
          if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = null
          }
          socket?.close()
          socket = null
        }
      }
    },
  }
}

/** 惰性派生 WS url：bun test 等无 DOM 环境无 `location`，退回占位以保证模块可加载。 */
function defaultWsUrl(): string {
  return typeof location === "undefined" ? "ws://localhost/ws" : `${location.origin.replace(/^http/, "ws")}/ws`
}

export const wsClient = createWsClient({ url: defaultWsUrl() })
