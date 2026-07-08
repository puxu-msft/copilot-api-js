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

import type {
  //
  EntrySummary,
  HistoryStats,
} from "../history/store"
import type {
  //
  ActiveRequestChangedWire,
  ActiveRequestWire,
} from "../observability/active-request-wire"

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
 * Hard cap on per-client TCP send buffer. When `bufferedAmount` exceeds this,
 * the client is dropped (socket force-closed, entry removed from `clients`).
 *
 * Rationale: `ws.send()` in Node/Bun WS implementations does NOT block or
 * throw when the peer is slow — it queues bytes into an internal JS-heap
 * buffer with no upper bound. A single tab in the background (browser tab
 * throttling), a suspended laptop, or a degraded network can let our high-
 * frequency broadcasts (every state_changed / updated → ~5 frames/s per
 * active request) pile up in that buffer indefinitely, retained by a strong
 * reference from `WebSocket._sender` — GC cannot reclaim it. Observed in
 * the wild: a 4GB heap OOM after ~5.5 hours with the History UI open.
 *
 * 4 MB matches a typical OS socket buffer size and is generous enough that
 * a brief stall (a few seconds of TCP-window collapse) does NOT drop a
 * healthy client. Sustained slow consumption WILL — that's the point.
 */
const MAX_BUFFERED_PER_CLIENT_BYTES = 4 * 1024 * 1024

/**
 * Factory for building the `connected` message data.
 * Set by start.ts after RequestContextManager is initialized.
 * Returns active requests snapshot for the connected event.
 */
let connectedDataFactory: (() => Array<ActiveRequestWire>) | null = null

/** Set the factory that provides active requests snapshot for connected events */
export function setConnectedDataFactory(factory: () => Array<ActiveRequestWire>): void {
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
 * Send `data` to every client matching `shouldSend` and split the result into
 * `delivered` (send returned without error and socket is OPEN) and `dead`
 * (closed, threw, or buffer over the per-client cap). Mutating `clients`
 * mid-iteration works in current V8 but reads as a foot-gun — collecting
 * first is the safer pattern.
 *
 * Slow-client backpressure: any client whose `bufferedAmount` exceeds
 * `MAX_BUFFERED_PER_CLIENT_BYTES` is moved to `dead` BEFORE attempting another
 * send. Without this, `ws.send()` accumulates frames in an unbounded JS-heap
 * buffer (Node/Bun WS implementations don't apply backpressure) and a single
 * slow consumer can OOM the proxy in hours under normal load.
 */
function sendToEach(data: string, shouldSend: (client: WSClient) => boolean): { delivered: Array<WebSocket>; dead: Array<WebSocket> } {
  const delivered: Array<WebSocket> = []
  const dead: Array<WebSocket> = []
  for (const [rawWs, client] of clients) {
    if (!shouldSend(client)) continue
    const buffered = getBufferedAmount(rawWs)
    if (buffered > MAX_BUFFERED_PER_CLIENT_BYTES) {
      consola.warn(`[WS] Dropping slow client (bufferedAmount=${buffered} > ${MAX_BUFFERED_PER_CLIENT_BYTES})`)
      dead.push(rawWs)
      continue
    }
    try {
      if (rawWs.readyState === WebSocket.OPEN) {
        rawWs.send(data)
        delivered.push(rawWs)
      } else {
        dead.push(rawWs)
      }
    } catch (error) {
      consola.debug("WebSocket send failed, removing client:", error)
      dead.push(rawWs)
    }
  }
  return { delivered, dead }
}

/**
 * Remove dead clients from the `clients` Map AND force-close their sockets.
 * The close is best-effort — onClose may have already fired (Map.delete is
 * idempotent on the consumer side, and broken sockets often throw on close);
 * we swallow errors so one bad client cannot stall the broadcast loop.
 *
 * Closing matters because for the slow-client backpressure path the socket
 * is still OPEN with megabytes queued; without close() the JS buffer keeps
 * growing until onClose finally fires (which may take minutes on a TCP
 * timeout). 1011 (internal error) + reason makes the reason observable to
 * the client too.
 */
function dropClients(dead: ReadonlyArray<WebSocket>): void {
  for (const ws of dead) {
    clients.delete(ws)
    try {
      ws.close(1011, "Backpressure: client too slow")
    } catch {
      // Already closing/closed — fine
    }
  }
}

/**
 * Read a WebSocket's `bufferedAmount` defensively. The field is part of the
 * standard interface but absent from some adapter typings — we centralize the
 * cast here so callers stay readable.
 */
function getBufferedAmount(ws: WebSocket): number {
  const amount = (ws as unknown as { bufferedAmount?: number }).bufferedAmount
  return typeof amount === "number" ? amount : 0
}

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
  const { dead } = sendToEach(data, (client) => client.topics.size === 0 || client.topics.has(topic))
  dropClients(dead)
}

/**
 * Broadcast a message to ALL clients regardless of their topic subscriptions.
 * Used for connection-level messages like `connected`.
 */
export function broadcastAlways(message: WSMessage): void {
  if (clients.size === 0) return
  const data = JSON.stringify(message)
  const { dead } = sendToEach(data, () => true)
  dropClients(dead)
}

/**
 * Broadcast and wait until every client's TCP write buffer drains (or a
 * deadline elapses). Use this for shutdown phase transitions where we MUST
 * guarantee the frame leaves the box before the socket is force-closed —
 * `broadcast()` only enqueues, and a subsequent `ws.close(force=true)` can
 * truncate the queued frame.
 *
 * Returns the count of clients whose buffer was still non-zero at deadline
 * (i.e. likely truncated). Caller can use this for diagnostics.
 *
 * Algorithm: poll `bufferedAmount` per client every `pollMs` until all reach 0
 * or `deadlineMs` elapses. We do NOT block on a single slow client — once the
 * deadline hits we return whatever clients are still buffering.
 */
export async function broadcastAndFlush(
  message: WSMessage,
  topic: WSTopic | "*",
  opts?: { deadlineMs?: number; pollMs?: number },
): Promise<{ stillBuffering: number }> {
  const deadlineMs = opts?.deadlineMs ?? 500
  const pollMs = opts?.pollMs ?? 10

  if (clients.size === 0) return { stillBuffering: 0 }

  const data = JSON.stringify(message)
  const shouldSend = topic === "*" ? () => true : (client: WSClient) => client.topics.size === 0 || client.topics.has(topic)

  const { delivered, dead } = sendToEach(data, shouldSend)
  dropClients(dead)

  // Poll bufferedAmount until drained or deadline.
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    const stillBuffering = delivered.filter((ws) => getBufferedAmount(ws) > 0)
    if (stillBuffering.length === 0) return { stillBuffering: 0 }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs)
      ;(timer as unknown as { unref: () => void }).unref()
    })
  }

  const stillBuffering = delivered.filter((ws) => getBufferedAmount(ws) > 0).length

  if (stillBuffering > 0) {
    consola.warn(`[WS] broadcastAndFlush deadline ${deadlineMs}ms hit with ${stillBuffering} client(s) still buffering`)
  }
  return { stillBuffering }
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
export function notifyActiveRequestChanged(data: ActiveRequestChangedWire): void {
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

// `notifyShutdownPhaseChangedAndFlush` was deleted in the observability
// rewrite (commit 4): shutdown.ts now publishes via the bus's
// `publishAndFlush`, which drives the same WS broadcast through WsSink +
// the synchronous `notifyShutdownPhaseChanged` above. Keeping the
// non-flush primitive remains useful for general phase transitions; the
// flush variant became a one-call dead export and was removed per 原则9.

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
        // event.data is string | Buffer | ArrayBuffer | Blob (per the WS event spec);
        // the client protocol is JSON text, so decode binary frames as UTF-8 rather
        // than calling String() (which would yield "[object Object]" for Buffer).
        // Blob shouldn't occur on the server side (Bun/Node WS yields Buffer/ArrayBuffer)
        // but we defensively drop it rather than feed garbage to JSON.parse.
        let raw: string
        if (typeof event.data === "string") {
          raw = event.data
        } else if (event.data instanceof ArrayBuffer) {
          raw = new TextDecoder().decode(event.data)
        } else if (ArrayBuffer.isView(event.data) && !(event.data instanceof SharedArrayBuffer)) {
          // Buffer / Uint8Array / etc. — but exclude SharedArrayBuffer which TextDecoder rejects.
          // Cast to BufferSource to satisfy strict TextDecoder typings across runtimes.
          raw = new TextDecoder().decode(event.data as unknown as Uint8Array)
        } else {
          return
        }
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
