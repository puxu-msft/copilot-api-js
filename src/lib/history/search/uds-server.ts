/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 2 — UDS server (sidecar side). Accepts connections on a Unix domain socket,
 * decodes length-prefixed JSON requests (`protocol.ts`), calls an injected search
 * function, and replies with a length-prefixed JSON response.
 *
 * Deliberately takes a plain `search` callback rather than a `HistorySearchDaemon`
 * directly -- keeps this module agnostic of daemon construction/lifecycle (P3's
 * process entry point wires `daemon.search` in), and lets tests exercise the wire
 * protocol against a trivial injected function without needing a real db/native
 * index.
 *
 * Crash-safety (this is the whole point of moving search out-of-process — a
 * transport bug here must never crash the SIDECAR either, even though it is only
 * one process away from the supervisor's restart):
 *  - every accepted connection gets `withErrorSink` (crash-safety.ts) BEFORE any
 *    other listener is attached, so a socket RST/reset mid-request can never
 *    surface as this process's `uncaughtException`.
 *  - the server itself (also an EventEmitter -- `listen()` can emit `error` for
 *    EADDRINUSE/EACCES etc. even after a successful listen, e.g. a later FD
 *    exhaustion) gets the same sink.
 *  - a thrown/rejected `search` call is caught and turned into a `{ error }` wire
 *    reply -- never left to crash the connection handler.
 */

import fs from "node:fs"
import net from "node:net"

import { withErrorSink } from "~/lib/transport/crash-safety"

import {
  //
  encodeFrame,
  FrameDecoder,
  type HistorySearchWireError,
  type HistorySearchWireRequest,
  type HistorySearchWireResponse,
} from "./protocol"

export type HistorySearchQueryFn = (
  query: string,
  operationKind: string | undefined,
  limit: number,
) => Promise<Array<{ operationId: string; createdAt: number; score: number }>>

export interface HistorySearchUdsServer {
  /** Start listening on `socketPath`. Unlinks a stale leftover socket FILE first (never a
   *  non-socket path — see `unlinkStaleSocket` doc). Resolves once actually listening. */
  listen: () => Promise<void>
  /** Stop accepting new connections, destroy in-flight connections, and unlink the socket
   *  file this server created (never-throw on the unlink — a missing/already-gone file is fine). */
  close: () => Promise<void>
}

/**
 * Remove a leftover socket-path FILE before `listen()`, so a stale artifact from a
 * crashed/killed prior sidecar process does not turn every restart into a fatal
 * EADDRINUSE (confirmed empirically: `net.Server.listen(path)` refuses ANY existing
 * path at that location, socket or not). Only ever unlinks a path that `lstat`
 * proves IS an actual socket file — a stray non-socket file at that path (an
 * operator mistake, an unrelated collision) is left untouched and `listen()` is
 * allowed to fail loudly with its own EADDRINUSE, rather than this function
 * silently deleting something it does not own.
 */
function unlinkStaleSocket(socketPath: string): void {
  try {
    const stat = fs.lstatSync(socketPath)
    if (stat.isSocket()) fs.unlinkSync(socketPath)
  } catch {
    // ENOENT (nothing to unlink) or a transient stat/unlink race — either way `listen()`
    // below is the real gate; this is best-effort cleanup, not the source of truth.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Construct (but do not yet start) a sidecar UDS server bound to `search`. */
export function createHistorySearchUdsServer(socketPath: string, search: HistorySearchQueryFn): HistorySearchUdsServer {
  const server: net.Server = withErrorSink(net.createServer())
  // Tracked directly (not via `net.Server`'s own connection bookkeeping, which is
  // private) so `close()` can proactively destroy every open connection rather than
  // waiting on each peer to half-close on its own — a client that never does so
  // would otherwise hang `server.close()`'s callback forever.
  const activeSockets = new Set<net.Socket>()

  server.on("connection", (socket) => {
    // withErrorSink FIRST, before any other listener — a peer RST/reset arriving
    // before the decoder even sees a full frame must never crash this process.
    withErrorSink(socket)
    activeSockets.add(socket)
    socket.on("close", () => activeSockets.delete(socket))
    const decoder = new FrameDecoder()

    socket.on("data", (chunk) => {
      let requests: Array<unknown>
      try {
        requests = decoder.push(chunk)
      } catch (error) {
        // A malformed/hostile frame (oversized length prefix, undecodable JSON) is a
        // protocol violation from THIS peer only — destroy just this connection, never
        // let it escape as an unhandled exception.
        socket.destroy(error instanceof Error ? error : new Error(errorText(error)))
        return
      }
      for (const request of requests) {
        void handleRequest(request, socket, search)
      }
    })
  })

  async function listen(): Promise<void> {
    unlinkStaleSocket(socketPath)
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off("error", onError)
        resolve()
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(socketPath)
    })
  }

  async function close(): Promise<void> {
    await new Promise<void>((resolve) => {
      for (const socket of activeSockets) socket.destroy()
      server.close(() => resolve())
    })
    unlinkStaleSocket(socketPath) // best-effort: remove OUR OWN socket file on clean shutdown
  }

  return { listen, close }
}

async function handleRequest(request: unknown, socket: net.Socket, search: HistorySearchQueryFn): Promise<void> {
  try {
    const { query, operationKind, limit } = request as Partial<HistorySearchWireRequest>
    if (typeof query !== "string" || typeof limit !== "number") {
      writeReply(socket, { error: `[history-search-uds] malformed request: ${JSON.stringify(request)}` })
      return
    }
    const rows = await search(query, operationKind, limit)
    const response: HistorySearchWireResponse = { rows }
    writeReply(socket, response)
  } catch (error) {
    const reply: HistorySearchWireError = { error: errorText(error) }
    writeReply(socket, reply)
  }
}

function writeReply(socket: net.Socket, reply: HistorySearchWireResponse | HistorySearchWireError): void {
  // The socket may already be destroyed (peer disconnected mid-request) by the time
  // the async search() call resolves -- writing to a destroyed socket would itself
  // throw/emit 'error'; `.writable` guards that without needing a try/catch around
  // a call whose failure is expected and inconsequential (the peer is gone).
  if (!socket.writable) return
  socket.write(encodeFrame(reply))
}
