/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 2 — UDS server (sidecar side). Accepts connections on a Unix domain socket,
 * decodes length-prefixed JSON requests (`protocol.ts`), calls an injected search
 * function, and replies with a length-prefixed JSON response.
 *
 * Deliberately takes a plain `search` callback rather than a `HistorySearchDaemon`
 * directly -- keeps this module agnostic of daemon construction/lifecycle
 * (daemon-entry.ts wires `daemon.search` in), and lets tests exercise the wire
 * protocol against a trivial injected function without needing a real db/native
 * index.
 *
 * Crash-safety (this is the whole point of moving search out-of-process — a
 * transport bug here must never crash the SIDECAR: since Phase 3′'s 2026-07-21
 * architecture revision, the sidecar is an independently-started, systemd-managed
 * SERVICE with no in-process supervisor of its own at all -- its own crash-loop
 * protection, restart policy, and backoff are entirely `systemd`'s job
 * (`Restart=on-failure`, `RestartSec=`), so a crash here is not "one process away
 * from a restart" the way it briefly was in the retired Phase 3 design -- it is
 * the ENTIRE remaining safety net for this process, which is exactly why these
 * guards matter just as much, if not more):
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
  type HistorySearchWireStatus,
} from "./protocol"

export type HistorySearchQueryFn = (
  query: string,
  operationKind: string | undefined,
  limit: number,
) => Promise<Array<{ operationId: string; createdAt: number; score: number }>>

/** Synchronous accessor for the daemon's current tail-progress status (blocker 3,
 *  2026-07-22) -- deliberately synchronous (no I/O, just reading in-memory counters
 *  the tail loop already maintains), so answering a `{type:"status"}` request never
 *  competes with an in-flight tail round or search query for any lock/resource. */
export type HistorySearchStatusFn = () => HistorySearchWireStatus["status"]

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
 * path at that location, socket or not).
 *
 * Only ever unlinks a path that BOTH (a) `lstat` proves IS an actual socket file
 * AND (b) a live connection PROBE proves has no active listener. (a) alone is not
 * enough in the resident-service architecture (Phase 3′): two independently-
 * started sidecar instances could otherwise race for the same socket path — the
 * second one's `listen()` must NOT silently steal the path out from under a
 * still-running first instance (that would be a much worse failure than a loud
 * EADDRINUSE: the operator would have two sidecars racing to serve, or the first
 * one's socket clients silently starts talking to the wrong process's queue). The
 * probe: attempt `net.connect(socketPath)` — a successful `connect` proves a live
 * peer is listening (do NOT unlink; let `listen()` fail loudly with its own
 * EADDRINUSE so a genuine double-start is visible to the operator); `ENOENT` or
 * `ECONNREFUSED` proves the peer is gone (safe to unlink) — confirmed empirically
 * that Bun's `net.connect` reports `ENOENT` for a path whose original listener
 * process was killed (the socket-path FILE itself still exists on disk, `lstat`
 * still sees it, but nothing is bound there anymore), while Node reports the
 * conventional `ECONNREFUSED` for the identical scenario — both runtimes must be
 * treated as "dead, safe to reclaim". Any OTHER connect error (e.g. EACCES from a
 * permission problem) is treated conservatively as "cannot tell, leave it alone"
 * — `listen()` will then fail with its own error, which is at least honest.
 *
 * A stray non-socket file at this path (an operator mistake, an unrelated
 * collision) is left untouched regardless — `listen()` is allowed to fail loudly
 * with its own EADDRINUSE, rather than this function silently deleting something
 * it does not own.
 */
async function unlinkStaleSocket(socketPath: string): Promise<void> {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(socketPath)
  } catch {
    return // ENOENT (nothing to unlink) or a transient stat race -- `listen()` is the real gate.
  }
  if (!stat.isSocket()) return // not ours to touch -- see doc above.

  const hasLivePeer = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath)
    // withErrorSink is unnecessary here: this promise's own 'error' listener
    // (attached synchronously, before any await/microtask yield) is the ONLY
    // listener this transient probe socket will ever have, so there is no
    // window where an 'error' could arrive unheard.
    probe.once("connect", () => {
      probe.destroy()
      resolve(true)
    })
    probe.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code
      // ENOENT: Bun's observed behavior for a dead peer at an existing socket-path
      // file. ECONNREFUSED: Node's (and the POSIX-conventional) behavior for the
      // same dead-peer scenario. Both mean "dead, NOT a live peer" -- resolve
      // `false`. Anything else (e.g. EACCES) is left alone -- conservatively
      // resolve `true` (assume a live peer we simply could not confirm), rather
      // than risk deleting a socket still in use.
      resolve(code !== "ENOENT" && code !== "ECONNREFUSED")
    })
  })
  if (!hasLivePeer) {
    try {
      fs.unlinkSync(socketPath)
    } catch {
      // Lost a race with something else removing it first, or a transient fs
      // error -- either way, `listen()` below is the real gate.
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Construct (but do not yet start) a sidecar UDS server bound to `search`. `getStatus`
 *  (blocker 3, 2026-07-22) is OPTIONAL -- tests exercising just the search wire
 *  protocol need not supply one; a `{type:"status"}` request against a server built
 *  without it degrades to a `{error}` wire reply (never a crash), same as any other
 *  malformed/unsupported request. */
export function createHistorySearchUdsServer(socketPath: string, search: HistorySearchQueryFn, getStatus?: HistorySearchStatusFn): HistorySearchUdsServer {
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
        void handleRequest(request, socket, search, getStatus)
      }
    })
  })

  async function listen(): Promise<void> {
    await unlinkStaleSocket(socketPath)
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
    // Direct unlink (not the connect-probe path above) -- we just stopped
    // listening on this exact path ourselves, so there is no "is some OTHER
    // process still using it" question to answer; a probe here would only add
    // a needless round-trip (and could itself race a brand-new listener that
    // started on this path in the interim).
    try {
      fs.unlinkSync(socketPath)
    } catch {
      // ENOENT (already gone) or a transient fs race -- best-effort cleanup on
      // our own clean shutdown, not a correctness requirement.
    }
  }

  return { listen, close }
}

async function handleRequest(request: unknown, socket: net.Socket, search: HistorySearchQueryFn, getStatus: HistorySearchStatusFn | undefined): Promise<void> {
  try {
    const { type, query, operationKind, limit } = request as Partial<HistorySearchWireRequest>
    if (type === "status") {
      if (!getStatus) {
        writeReply(socket, { error: "[history-search-uds] this server does not support status requests" })
        return
      }
      const status: HistorySearchWireStatus = { status: getStatus() }
      writeReply(socket, status)
      return
    }
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

function writeReply(socket: net.Socket, reply: HistorySearchWireResponse | HistorySearchWireStatus | HistorySearchWireError): void {
  // The socket may already be destroyed (peer disconnected mid-request) by the time
  // the async search() call resolves -- writing to a destroyed socket would itself
  // throw/emit 'error'; `.writable` guards that without needing a try/catch around
  // a call whose failure is expected and inconsequential (the peer is gone).
  if (!socket.writable) return
  socket.write(encodeFrame(reply))
}
