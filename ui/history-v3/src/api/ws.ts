import type { EntrySummary, HistoryStats } from "@/types"
import type { WSMessage } from "@/types/ws"

export interface WSClientOptions {
  onEntryAdded: (summary: EntrySummary) => void
  onEntryUpdated: (summary: EntrySummary) => void
  onStatsUpdated: (stats: HistoryStats) => void
  onConnected: (clientCount: number) => void
  onHistoryCleared: () => void
  onSessionDeleted: (sessionId: string) => void
  onStatusChange: (connected: boolean) => void
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
    this.options.onStatusChange(false)
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private createConnection(): void {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:"
    const url = `${protocol}//${location.host}/history/ws`

    try {
      this.ws = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.ws.addEventListener("open", () => {
      this.reconnectDelay = 1000
      this.options.onStatusChange(true)
    })

    this.ws.addEventListener("close", () => {
      this.options.onStatusChange(false)
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
        this.options.onEntryAdded(msg.data as EntrySummary)
        break
      }
      case "entry_updated": {
        this.options.onEntryUpdated(msg.data as EntrySummary)
        break
      }
      case "stats_updated": {
        this.options.onStatsUpdated(msg.data as HistoryStats)
        break
      }
      case "connected": {
        this.options.onConnected((msg.data as { clientCount: number }).clientCount)
        break
      }
      case "history_cleared": {
        this.options.onHistoryCleared()
        break
      }
      case "session_deleted": {
        this.options.onSessionDeleted((msg.data as { sessionId: string }).sessionId)
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
