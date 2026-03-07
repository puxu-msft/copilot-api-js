/**
 * WebSocket support for History API.
 * Enables real-time updates when new requests are recorded.
 */

import consola from "consola"

import type { EntrySummary, HistoryStats } from "./store"

/** Discriminated union of WebSocket message types */
export type WSMessageType =
  | "entry_added"
  | "entry_updated"
  | "stats_updated"
  | "history_cleared"
  | "session_deleted"
  | "connected"

/** A WebSocket message sent to connected clients */
export interface WSMessage {
  type: WSMessageType
  data: unknown
  timestamp: number
}

/** Track connected WebSocket clients */
const clients = new Set<WebSocket>()

/** Register a new WebSocket client and send connection confirmation */
export function addClient(ws: WebSocket): void {
  clients.add(ws)

  // Send connected confirmation
  const msg: WSMessage = {
    type: "connected",
    data: { clientCount: clients.size },
    timestamp: Date.now(),
  }
  ws.send(JSON.stringify(msg))
}

/** Unregister a WebSocket client */
export function removeClient(ws: WebSocket): void {
  clients.delete(ws)
}

/** Get the number of currently connected WebSocket clients */
export function getClientCount(): number {
  return clients.size
}

/** Close all connected WebSocket clients */
export function closeAllClients(): void {
  for (const client of clients) {
    try {
      client.close(1001, "Server shutting down")
    } catch {
      // Ignore errors during shutdown
    }
  }
  clients.clear()
}

function broadcast(message: WSMessage): void {
  const data = JSON.stringify(message)
  for (const client of clients) {
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data)
      } else {
        // Remove clients that are no longer open (CLOSING, CLOSED)
        clients.delete(client)
      }
    } catch (error) {
      consola.debug("WebSocket send failed, removing client:", error)
      clients.delete(client)
    }
  }
}

/** Called when a new entry is recorded */
export function notifyEntryAdded(summary: EntrySummary): void {
  if (clients.size === 0) return

  broadcast({
    type: "entry_added",
    data: summary,
    timestamp: Date.now(),
  })
}

/** Called when an entry is updated (e.g., response received) */
export function notifyEntryUpdated(summary: EntrySummary): void {
  if (clients.size === 0) return

  broadcast({
    type: "entry_updated",
    data: summary,
    timestamp: Date.now(),
  })
}

/** Called when stats change */
export function notifyStatsUpdated(stats: HistoryStats): void {
  if (clients.size === 0) return

  broadcast({
    type: "stats_updated",
    data: stats,
    timestamp: Date.now(),
  })
}

/** Called when all history is cleared */
export function notifyHistoryCleared(): void {
  if (clients.size === 0) return

  broadcast({
    type: "history_cleared",
    data: null,
    timestamp: Date.now(),
  })
}

/** Called when a session is deleted */
export function notifySessionDeleted(sessionId: string): void {
  if (clients.size === 0) return

  broadcast({
    type: "session_deleted",
    data: { sessionId },
    timestamp: Date.now(),
  })
}
