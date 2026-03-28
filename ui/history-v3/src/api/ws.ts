import type { EntrySummary, HistoryStats } from "@/types"
import type { WSMessage } from "@/types/ws"

/** Active request summary from WS event */
export interface ActiveRequestInfo {
  id: string
  endpoint: string
  state: string
  startTime: number
  durationMs: number
  model?: string
  stream?: boolean
  attemptCount?: number
  currentStrategy?: string
  queueWaitMs?: number
}

/** Rate limiter change payload */
export interface RateLimiterChangeInfo {
  mode: "normal" | "rate-limited" | "recovering"
  previousMode: string
  queueLength: number
  consecutiveSuccesses: number
  rateLimitedAt: number | null
}

/** Shutdown phase change payload */
export interface ShutdownPhaseChangeInfo {
  phase: string
  previousPhase: string
}

/** Active request changed payload */
export interface ActiveRequestChangedInfo {
  action: "created" | "state_changed" | "completed" | "failed"
  request?: ActiveRequestInfo
  requestId?: string
  activeCount: number
}

export interface WSClientOptions {
  /** Topics to subscribe to. If omitted, receives all events. */
  topics?: Array<string>

  // History events
  onEntryAdded?: (summary: EntrySummary) => void
  onEntryUpdated?: (summary: EntrySummary) => void
  onStatsUpdated?: (stats: HistoryStats) => void
  onHistoryCleared?: () => void
  onSessionDeleted?: (sessionId: string) => void

  // Connection events
  onConnected?: (clientCount: number) => void
  onStatusChange?: (connected: boolean) => void

  // Requests events
  onActiveRequestChanged?: (data: ActiveRequestChangedInfo) => void

  // Status events
  onRateLimiterChanged?: (data: RateLimiterChangeInfo) => void
  onShutdownPhaseChanged?: (data: ShutdownPhaseChangeInfo) => void
}

export class WSClient {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  private intentionalClose = false

  constructor(private options: WSClientOptions) {}

  connect(): void {
    this.intentionalClose = false
    this.createConnection()
  }

  disconnect(): void {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.options.onStatusChange?.(false)
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private createConnection(): void {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:"
    const url = `${protocol}//${location.host}/ws`

    try {
      this.ws = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.ws.addEventListener("open", () => {
      this.reconnectDelay = 1000
      this.options.onStatusChange?.(true)

      // Subscribe to requested topics (omit to receive all)
      if (this.options.topics) {
        this.ws?.send(JSON.stringify({ type: "subscribe", topics: this.options.topics }))
      }
    })

    this.ws.addEventListener("close", () => {
      this.options.onStatusChange?.(false)
      if (!this.intentionalClose) {
        this.scheduleReconnect()
      }
    })

    this.ws.addEventListener("error", () => {
      // onclose will fire after this
    })

    this.ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string) as WSMessage
        this.handleMessage(msg)
      } catch {
        // Ignore malformed messages
      }
    })
  }

  private handleMessage(msg: WSMessage): void {
    switch (msg.type) {
      case "entry_added": {
        this.options.onEntryAdded?.(msg.data as EntrySummary)
        break
      }
      case "entry_updated": {
        this.options.onEntryUpdated?.(msg.data as EntrySummary)
        break
      }
      case "stats_updated": {
        this.options.onStatsUpdated?.(msg.data as HistoryStats)
        break
      }
      case "connected": {
        this.options.onConnected?.((msg.data as { clientCount: number }).clientCount)
        break
      }
      case "history_cleared": {
        this.options.onHistoryCleared?.()
        break
      }
      case "session_deleted": {
        this.options.onSessionDeleted?.((msg.data as { sessionId: string }).sessionId)
        break
      }
      case "active_request_changed": {
        this.options.onActiveRequestChanged?.(msg.data as ActiveRequestChangedInfo)
        break
      }
      case "rate_limiter_changed": {
        this.options.onRateLimiterChanged?.(msg.data as RateLimiterChangeInfo)
        break
      }
      case "shutdown_phase_changed": {
        this.options.onShutdownPhaseChanged?.(msg.data as ShutdownPhaseChangeInfo)
        break
      }
      default: {
        break
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.createConnection()
    }, this.reconnectDelay)
    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
  }
}
