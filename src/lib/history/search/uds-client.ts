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
 * CRASH-SAFETY: a `connect ENOENT`/`ECONNREFUSED` on this socket that has no
 * `'error'` listener becomes the MAIN process's `uncaughtException`, which
 * `main.ts`'s global handler turns into `process.exit(1)`. This is EXACTLY the
 * crash-amplification chain the whole out-of-process plan exists to prevent,
 * except here it would hit the very process the plan is protecting.
 *
 * The critical subtlety (verified empirically, Bun 1.3.14): `net.connect(path)`
 * STARTS the connection attempt BEFORE it returns the socket, so a listener
 * attached to the returned socket can arrive too late. Standalone it looks async
 * (the ENOENT `'error'` fires on a later tick, so a listener attached right after
 * `net.connect()` catches it) — but INSIDE a `Bun.serve` request-handler event
 * loop the `'error'` is delivered before the caller regains control, so
 * `withErrorSink`-after-`net.connect` is defeated and the process crashes (this
 * was a real production `exit(1)` when the sidecar socket was absent; the earlier
 * "async, so a post-connect listener is safe" claim was a false-green verified
 * outside a request handler). It is NOT a synchronous throw either, so `query()`'s
 * try/catch cannot see it — it escapes as `uncaughtException`.
 *
 * Fix: never use `net.connect()` here. Construct an UNCONNECTED `new net.Socket()`,
 * attach the error sink + the real `'error'` listener (and all other handlers)
 * FIRST, and only then call `socket.connect(path)` — the listeners provably
 * predate any connection attempt, closing the window on both runtimes and in both
 * event-loop contexts.
 */

import net from "node:net"

import { withErrorSink } from "~/lib/transport/crash-safety"

import {
  //
  encodeFrame,
  FrameDecoder,
  isWireError,
  isWireStatus,
  type HistorySearchWireResponse,
  type HistorySearchWireStatus,
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
  /**
   * Fetch the sidecar's tail-progress status (blocker 3, 2026-07-22) — DOES
   * distinguish success from failure (mirrors `pingHistorySearchUdsClient`'s
   * never-silently-degrade contract, deliberately NOT the never-throw contract
   * `query()` has): `/api/status` needs to tell "sidecar unreachable" apart from
   * "sidecar reachable but its tail loop has stopped making progress" (e.g. wedged
   * on a permanently-poisoned row, or simply never started tailing) — a plain
   * connectivity ping (`pingHistorySearchUdsClient`) cannot see the difference,
   * since the native short-circuit it relies on answers instantly regardless of
   * tail health. Rejects on any transport/protocol failure exactly like
   * `queryOnce` would (unreachable socket, timeout, malformed frame, `{error}`
   * wire reply, or a server built without `getStatus` wired in).
   */
  getTailStatus: () => Promise<HistorySearchWireStatus["status"]>
}

/** Outcome of a lightweight reachability probe — unlike `query()`, this DOES
 *  distinguish success from failure (status/diagnostic reporting needs that
 *  distinction; a real search query deliberately does not expose it). */
export interface HistorySearchPingResult {
  reachable: boolean
  latencyMs: number
  error?: string
}

const DEFAULT_CONNECT_TIMEOUT_MS = 2_000
const DEFAULT_QUERY_TIMEOUT_MS = 5_000
/** Kept short — this is used for a per-request /api/status reachability check
 *  (the independent history-search sidecar service may simply not be installed/
 *  started at all, which is a normal, common, non-error state), so a slow
 *  status response every time it is absent would be its own problem. */
const DEFAULT_PING_TIMEOUT_MS = 300

/**
 * Lightweight reachability probe for status/diagnostic reporting — an empty
 * query + `limit: 0` (the native sidecar's own `search_blocking` short-circuits
 * before touching Tantivy for either condition, see native/history-search/src/
 * lib.rs, so this is cheap even against a real, busy sidecar), but critically
 * exposes the ACTUAL success/failure outcome that `query()` deliberately
 * discards (never-throw is the right contract for a real search query feeding
 * user-facing results; `/api/status` instead needs to know precisely whether
 * the sidecar answered so an operator can tell "not installed" from "installed
 * and working").
 */
export function pingHistorySearchUdsClient(socketPath: string, timeoutMs: number = DEFAULT_PING_TIMEOUT_MS): Promise<HistorySearchPingResult> {
  const start = Date.now()
  return sendRequest(socketPath, { query: "", operationKind: undefined, limit: 0 }, timeoutMs, timeoutMs).then(
    () => ({ reachable: true, latencyMs: Date.now() - start }),
    (error: unknown) => ({ reachable: false, latencyMs: Date.now() - start, error: error instanceof Error ? error.message : String(error) }),
  )
}

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
      const reply = await sendRequest(options.socketPath, { query: queryText, operationKind, limit }, connectTimeoutMs, queryTimeoutMs)
      return (reply as HistorySearchWireResponse).rows
    } catch {
      // Never-throw contract (see module doc): ANY failure -- connect error, timeout,
      // malformed frame, server-side `{ error }` reply -- degrades to empty results.
      return []
    }
  }

  async function getTailStatus(): Promise<HistorySearchWireStatus["status"]> {
    const reply = await sendRequest(options.socketPath, { type: "status", query: "", operationKind: undefined, limit: 0 }, connectTimeoutMs, queryTimeoutMs)
    if (!isWireStatus(reply)) throw new Error("[history-search-uds] expected a status reply, got a search response")
    return reply.status
  }

  return { query, getTailStatus }
}

interface WireRequestInput {
  type?: "status"
  query: string
  operationKind: string | undefined
  limit: number
}

/** Send one request over a fresh connection and resolve with the DECODED reply
 *  (either a search response or a status response -- callers narrow via
 *  `isWireStatus`/direct field access). Rejects (never throws synchronously) on any
 *  transport/protocol failure -- callers decide whether to degrade (`query()`,
 *  never-throw) or propagate (`getTailStatus()`, does throw). */
function sendRequest(
  socketPath: string,
  request: WireRequestInput,
  connectTimeoutMs: number,
  queryTimeoutMs: number,
): Promise<HistorySearchWireResponse | HistorySearchWireStatus> {
  return new Promise((resolve, reject) => {
    // UNCONNECTED socket — `.connect()` is called LAST, only after every listener
    // (error sink, real error, connect, data, close, end) is armed. `net.connect()`
    // would start connecting before returning, letting a `connect ENOENT`/`ECONNREFUSED`
    // `'error'` fire before we can attach a listener (defeated `withErrorSink` inside a
    // Bun.serve request handler → real production `uncaughtException` → exit(1); see
    // module doc). Constructing the socket unconnected removes that window entirely.
    const socket = new net.Socket()
    // withErrorSink STILL first (defense-in-depth for a LATE teardown re-emit: `finish()`
    // → `socket.destroy()` can emit `'error'` again after settle, and `.on` outlives it).
    withErrorSink(socket)

    let settled = false
    let queryTimer: ReturnType<typeof setTimeout> | undefined
    const decoder = new FrameDecoder()

    const finish = (value: HistorySearchWireResponse | HistorySearchWireStatus | Error): void => {
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
      finish(reply as HistorySearchWireResponse | HistorySearchWireStatus)
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

    // LAST: every listener above is now armed, so no `connect ENOENT`/`ECONNREFUSED`
    // `'error'` can land in an unlistened window (see module doc for why this ordering
    // is load-bearing, not cosmetic).
    socket.connect(socketPath)
  })
}
