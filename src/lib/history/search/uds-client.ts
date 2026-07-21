/**
 * History-search out-of-process plan (docs/plan/2026-07-21-history-search-out-of-process.md)
 * Phase 2 — UDS client (main-process side). Queries the sidecar's search over the
 * length-prefixed JSON wire (`protocol.ts`).
 *
 * NEVER-THROW CONTRACT (this is the entire point of the out-of-process design —
 * a sidecar that is down, crashed mid-restart, hung, or sends garbage must
 * degrade the MAIN process's search results to empty, never propagate a
 * failure): `query()` never rejects. Every failure mode below resolves to `[]`:
 *   - the socket path does not exist (sidecar never started / still starting)
 *   - the connection is refused/reset immediately after connecting
 *   - the server accepts but never responds (hang) -- bounded by `queryTimeoutMs`
 *   - connecting itself takes too long -- bounded by `connectTimeoutMs`
 *   - the server sends a malformed/undecodable frame
 *   - the server sends a `{ error }` wire reply
 *
 * CRASH-SAFETY: `net.connect()` emits `error` ASYNCHRONOUSLY for a path that does
 * not exist (ENOENT) or refuses the connection (ECONNREFUSED) — confirmed
 * empirically that an unlistened `error` on this socket becomes this (the MAIN)
 * process's `uncaughtException`, which `main.ts`'s global handler turns into
 * `process.exit(1)`. This is EXACTLY the crash-amplification chain the whole
 * out-of-process plan exists to prevent, except here it would hit the very
 * process the plan is protecting. Every socket this module creates gets an
 * `error` listener attached BEFORE any other operation (via `withErrorSink`,
 * mirrored from `crash-safety.ts`) — never conditionally, never after a delay.
 */

import net from "node:net"

import { withErrorSink } from "~/lib/transport/crash-safety"

import {
  //
  encodeFrame,
  FrameDecoder,
  isWireError,
  type HistorySearchWireResponse,
} from "./protocol"

export interface HistorySearchUdsClientOptions {
  socketPath: string
  /** Deadline for establishing the connection. */
  connectTimeoutMs?: number
  /** Deadline for receiving a complete response after the request is written. */
  queryTimeoutMs?: number
}

export interface HistorySearchUdsClient {
  /**
   * Query the sidecar. NEVER throws/rejects — every failure mode (see module doc)
   * resolves to an empty array, mirroring the REST layer's `partial: true`
   * degrade-to-empty contract for an unavailable sidecar.
   */
  query: (query: string, operationKind: string | undefined, limit: number) => Promise<Array<{ operationId: string; createdAt: number; score: number }>>
}

const DEFAULT_CONNECT_TIMEOUT_MS = 2_000
const DEFAULT_QUERY_TIMEOUT_MS = 5_000

/** Construct a client bound to one sidecar socket path. Stateless across calls --
 *  each `query()` opens its own short-lived connection (simple and robust: no
 *  connection-reuse bookkeeping, no risk of a stale/half-broken kept-alive
 *  connection silently poisoning every future query — a single search request/
 *  response is cheap enough that per-call connection setup is not a real cost). */
export function createHistorySearchUdsClient(options: HistorySearchUdsClientOptions): HistorySearchUdsClient {
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS

  async function query(
    queryText: string,
    operationKind: string | undefined,
    limit: number,
  ): Promise<Array<{ operationId: string; createdAt: number; score: number }>> {
    try {
      return await queryOnce(options.socketPath, { query: queryText, operationKind, limit }, connectTimeoutMs, queryTimeoutMs)
    } catch {
      // Never-throw contract (see module doc): ANY failure -- connect error, timeout,
      // malformed frame, server-side `{ error }` reply -- degrades to empty results.
      return []
    }
  }

  return { query }
}

interface WireRequestInput {
  query: string
  operationKind: string | undefined
  limit: number
}

function queryOnce(
  socketPath: string,
  request: WireRequestInput,
  connectTimeoutMs: number,
  queryTimeoutMs: number,
): Promise<Array<{ operationId: string; createdAt: number; score: number }>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    // withErrorSink FIRST, synchronously, before ANY other listener or timer is
    // armed — an ENOENT/ECONNREFUSED `error` can fire on the very next microtask
    // (see module doc); there must be no window where it is unheard.
    withErrorSink(socket)

    let settled = false
    let queryTimer: ReturnType<typeof setTimeout> | undefined
    const decoder = new FrameDecoder()

    const finish = (value: Array<{ operationId: string; createdAt: number; score: number }> | Error): void => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(queryTimer)
      socket.destroy()
      if (value instanceof Error) reject(value)
      else resolve(value)
    }

    // `withErrorSink` already prevents a crash; this is the SEPARATE concern of
    // actually reacting to the failure (settling the promise) — a real, additive
    // listener alongside the sink (crash-safety.ts's contract: the sink never
    // consumes, so a real listener still fires independently).
    socket.on("error", (error) => finish(error))

    const connectTimer = setTimeout(() => finish(new Error(`[history-search-uds] connect timeout after ${connectTimeoutMs}ms`)), connectTimeoutMs)
    connectTimer.unref()

    socket.once("connect", () => {
      clearTimeout(connectTimer)
      queryTimer = setTimeout(() => finish(new Error(`[history-search-uds] query timeout after ${queryTimeoutMs}ms`)), queryTimeoutMs)
      queryTimer.unref()
      socket.write(encodeFrame(request))
    })

    socket.on("data", (chunk) => {
      let replies: Array<unknown>
      try {
        replies = decoder.push(chunk)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (replies.length === 0) return
      const reply = replies[0]
      if (isWireError(reply)) {
        finish(new Error(`[history-search-uds] sidecar error: ${reply.error}`))
        return
      }
      finish((reply as HistorySearchWireResponse).rows)
    })

    socket.on("close", () => finish(new Error("[history-search-uds] connection closed before a response arrived")))
    // A peer that destroys its side WITHOUT ever writing an EPIPE-triggering error
    // back (confirmed empirically: Bun's net.Socket delivers only 'end', never
    // 'error'/'close', for this exact "server destroyed right after accept" case —
    // Node instead surfaces an EPIPE 'error' on the pending write) would otherwise
    // hang this promise until `queryTimeoutMs` on Bun specifically. Treat a
    // half-close with no reply yet the same as a hard close: `finish()` itself
    // calls `socket.destroy()`, which reliably drives the 'close' event afterward
    // on both runtimes.
    socket.on("end", () => finish(new Error("[history-search-uds] connection ended before a response arrived")))
  })
}
