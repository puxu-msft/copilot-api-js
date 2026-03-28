/**
 * Topic-aware WebSocket broadcast system.
 *
 * Clients connect to `/ws` and optionally subscribe to topics via:
 *   `{ type: "subscribe", topics: ["history", "requests", "status"] }`
 *
 * Clients with no subscriptions (empty topics set) receive ALL broadcasts.
 * Clients with subscriptions only receive messages for their subscribed topics.
 *
 * The `broadcastAlways` function ignores topics entirely (used for `connected`).
 */

import type { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"

import consola from "consola"

import type { EntrySummary, HistoryStats } from "../history/store"

// ============================================================================
// Types
// ============================================================================

/** Known broadcast topics */
export type WSTopic = "history" | "requests" | "status"

/** All WebSocket message types (history events + new event types) */
export type WSMessageType =
  | "entry_added"
  | "entry_updated"
  | "stats_updated"
  | "history_cleared"
  | "session_deleted"
  | "connected"
  | "active_request_changed"
  | "rate_limiter_changed"
  | "shutdown_phase_changed"

/** A WebSocket message sent to connected clients */
export interface WSMessage {
  type: WSMessageType
  data: unknown
  timestamp: number
}

/** Client subscription message from the frontend */
interface SubscribeMessage {
  type: "subscribe"
  topics: Array<string>
}

/** Internal representation of a connected WebSocket client */
interface WSClient {
  ws: WebSocket
  /** Topics this client is subscribed to. Empty = receive all broadcasts. */
  topics: Set<string>
}

// ============================================================================
// Client management
// ============================================================================

/** Connected clients indexed by their raw WebSocket instance */
const clients = new Map<WebSocket, WSClient>()

/**
 * Factory for building the `connected` message data.
 * Set by start.ts after RequestContextManager is initialized.
 * Returns active requests snapshot for the connected event.
 */
let connectedDataFactory: (() => Array<unknown>) | null = null

/** Set the factory that provides active requests snapshot for connected events */
export function setConnectedDataFactory(factory: () => Array<unknown>): void {
  connectedDataFactory = factory
}

/** Register a new WebSocket client (starts with no topic subscriptions = receive all) */
export function addClient(ws: WebSocket): void {
  clients.set(ws, { ws, topics: new Set() })

  const activeRequests = connectedDataFactory?.() ?? []

  // Send connected confirmation to the newly connected client only
  const msg: WSMessage = {
    type: "connected",
    data: { clientCount: clients.size, activeRequests },
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
  for (const { ws } of clients.values()) {
    try {
      ws.close(1001, "Server shutting down")
    } catch {
      // Ignore errors during shutdown
    }
  }
  clients.clear()
}

/** Handle an incoming message from a client (topic subscription) */
export function handleClientMessage(ws: WebSocket, data: string): void {
  try {
    const parsed = JSON.parse(data) as unknown
    if (!isSubscribeMessage(parsed)) return

    const client = clients.get(ws)
    if (!client) return

    // Replace topics entirely — immutable update of the Set
    client.topics = new Set(parsed.topics)
    consola.debug(`[WS] Client subscribed to topics: [${[...client.topics].join(", ")}]`)
  } catch {
    // Ignore malformed messages
  }
}

// ============================================================================
// Broadcast
// ============================================================================

/**
 * Broadcast a message to clients subscribed to a specific topic.
 *
 * - Clients with no subscriptions (empty topics) receive the message (wildcard).
 * - Clients subscribed to the given topic receive the message.
 * - Clients subscribed to other topics (but not this one) are skipped.
 */
export function broadcast(message: WSMessage, topic: WSTopic): void {
  if (clients.size === 0) return

  const data = JSON.stringify(message)
  for (const [rawWs, client] of clients) {
    // Skip clients that have explicit subscriptions but not this topic
    if (client.topics.size > 0 && !client.topics.has(topic)) continue

    try {
      if (rawWs.readyState === WebSocket.OPEN) {
        rawWs.send(data)
      } else {
        // Remove clients that are no longer open (CLOSING, CLOSED)
        clients.delete(rawWs)
      }
    } catch (error) {
      consola.debug("WebSocket send failed, removing client:", error)
      clients.delete(rawWs)
    }
  }
}

/**
 * Broadcast a message to ALL clients regardless of their topic subscriptions.
 * Used for connection-level messages like `connected`.
 */
export function broadcastAlways(message: WSMessage): void {
  if (clients.size === 0) return

  const data = JSON.stringify(message)
  for (const [rawWs] of clients) {
    try {
      if (rawWs.readyState === WebSocket.OPEN) {
        rawWs.send(data)
      } else {
        clients.delete(rawWs)
      }
    } catch (error) {
      consola.debug("WebSocket send failed, removing client:", error)
      clients.delete(rawWs)
    }
  }
}

// ============================================================================
// History notify functions (topic: "history")
// ============================================================================

/** Called when a new entry is recorded */
export function notifyEntryAdded(summary: EntrySummary): void {
  if (clients.size === 0) return

  broadcast(
    {
      type: "entry_added",
      data: summary,
      timestamp: Date.now(),
    },
    "history",
  )
}

/** Called when an entry is updated (e.g., response received) */
export function notifyEntryUpdated(summary: EntrySummary): void {
  if (clients.size === 0) return

  broadcast(
    {
      type: "entry_updated",
      data: summary,
      timestamp: Date.now(),
    },
    "history",
  )
}

/** Called when stats change */
export function notifyStatsUpdated(stats: HistoryStats): void {
  if (clients.size === 0) return

  broadcast(
    {
      type: "stats_updated",
      data: stats,
      timestamp: Date.now(),
    },
    "history",
  )
}

/** Called when all history is cleared */
export function notifyHistoryCleared(): void {
  if (clients.size === 0) return

  broadcast(
    {
      type: "history_cleared",
      data: null,
      timestamp: Date.now(),
    },
    "history",
  )
}

/** Called when a session is deleted */
export function notifySessionDeleted(sessionId: string): void {
  if (clients.size === 0) return

  broadcast(
    {
      type: "session_deleted",
      data: { sessionId },
      timestamp: Date.now(),
    },
    "history",
  )
}

// ============================================================================
// New notify functions (exported but not yet called from trigger points)
// ============================================================================

/** Called when active request state changes (topic: "requests") */
export function notifyActiveRequestChanged(data: unknown): void {
  if (clients.size === 0) return

  broadcast(
    {
      type: "active_request_changed",
      data,
      timestamp: Date.now(),
    },
    "requests",
  )
}

/** Called when rate limiter state changes (topic: "status") */
export function notifyRateLimiterChanged(data: unknown): void {
  if (clients.size === 0) return

  broadcast(
    {
      type: "rate_limiter_changed",
      data,
      timestamp: Date.now(),
    },
    "status",
  )
}

/** Called when shutdown phase changes (topic: "status") */
export function notifyShutdownPhaseChanged(data: unknown): void {
  if (clients.size === 0) return

  broadcast(
    {
      type: "shutdown_phase_changed",
      data,
      timestamp: Date.now(),
    },
    "status",
  )
}

// ============================================================================
// WebSocket route registration
// ============================================================================

/**
 * Initialize the global WebSocket endpoint at `/ws`.
 * Registers the route on the root Hono app using the shared WebSocket adapter.
 *
 * @param rootApp - The root Hono app instance
 * @param upgradeWs - Shared WebSocket upgrade function from createWebSocketAdapter
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function initWebSocket(rootApp: Hono, upgradeWs: UpgradeWebSocket<any>): void {
  rootApp.get(
    "/ws",
    upgradeWs(() => ({
      onOpen(_event, ws) {
        addClient(ws.raw as unknown as WebSocket)
      },
      onClose(_event, ws) {
        removeClient(ws.raw as unknown as WebSocket)
      },
      onMessage(event, ws) {
        const raw = typeof event.data === "string" ? event.data : String(event.data)
        handleClientMessage(ws.raw as unknown as WebSocket, raw)
      },
      onError(event, ws) {
        consola.debug("WebSocket error:", event)
        removeClient(ws.raw as unknown as WebSocket)
      },
    })),
  )
}

// ============================================================================
// Helpers
// ============================================================================

/** Type guard for subscribe messages from the client */
function isSubscribeMessage(value: unknown): value is SubscribeMessage {
  if (typeof value !== "object" || value === null) return false
  const msg = value as Record<string, unknown>
  return msg.type === "subscribe" && Array.isArray(msg.topics)
}
