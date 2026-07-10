// No upstream WS application-layer keepalive here (unlike http2-client.ts's
// socket.setKeepAlive + scheduleH2KeepalivePing). PoC-verified (Task 4.1,
// exp/ws-upstream-keepalive/REPORT.md): `import {WebSocket} from "undici"` is
// runtime-split — under Bun it is native globalThis.WebSocket WITH a working
// .ping()/.pong(), under Node it is real undici with NO ping() and no socket
// accessor. But even Bun's WS PING is a control frame that does NOT produce a
// ResponsesStreamEvent, so it does NOT reset state.streamIdleTimeout (same as
// h2 PING) — it is at most prevention, never recovery, and its real GHC benefit
// is unproven. Do NOT "just add a WS ping": the recovery defense for WS long
// silences is Phase 3 buffered retry (spec R5.1). See docs/todo/deferred-backlog.md.
import consola from "consola"
import { WebSocket } from "undici"

import type {
  //
  ResponsesPayload,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import { copilotWsUrl } from "~/lib/copilot-api"
import { state } from "~/lib/state"
import { guardCallback } from "~/lib/transport/crash-safety"

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000
const CLOSE_CODE_NORMAL = 1000
const TERMINAL_EVENTS = new Set(["response.completed", "response.failed", "response.incomplete", "error"])

export interface CreateUpstreamWsConnectionOptions {
  headers: Record<string, string>
  model: string
  /**
   * Optional conversation identifier (e.g. from X-Conversation-Id header).
   * Used as a fallback reuse key when `previous_response_id` is absent —
   * mirrors GHC per-conversation WS pattern (#4827) for turn boundaries
   * that don't yet carry a stateful marker.
   */
  conversationId?: string
  onClose?: () => void
  idleTimeoutMs?: number
  createSocket?: (url: string, headers: Record<string, string>) => WebSocketLike
}

export interface WebSocketLike extends EventTarget {
  readonly readyState: number
  readonly OPEN: number
  readonly CONNECTING: number
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface UpstreamWsConnection {
  connect(opts?: { signal?: AbortSignal }): Promise<void>
  sendRequest(payload: ResponsesPayload, opts?: { abortSignal?: AbortSignal }): AsyncIterable<ResponsesStreamEvent>
  readonly isOpen: boolean
  readonly isBusy: boolean
  readonly statefulMarker: string | undefined
  readonly model: string
  readonly conversationId: string | undefined
  /** Headers captured at handshake time — used for reuse-diff diagnostics */
  readonly handshakeHeaders: Record<string, string>
  close(): void
}

interface AsyncQueue<T> {
  push(value: T): void
  close(): void
  fail(error: Error): void
  iterate(): AsyncGenerator<T>
}

/** Close an upstream WS with the WHATWG-legal normal-closure code (1000).
 *  RUNTIME-SPLIT (Task 4.1 PoC): `import { WebSocket } from "undici"` resolves to real undici
 *  (WHATWG-strict) on Node, but to Bun's NATIVE WebSocket on Bun. Real undici throws
 *  DOMException('invalid code') for any code outside {1000} ∪ [3000,4999] (e.g. the going-away /
 *  server-error codes); Bun-native tolerates 1001 et al. `1000` is safe on BOTH runtimes — the
 *  §1.1 incident ran on a real-undici/Node path where close(1001) threw and defeated the WS→HTTP
 *  fallback. The try/catch is defense-in-depth so a close never escalates a callback throw. */
function closeUpstreamWs(socket: WebSocketLike | null | undefined, reason: string): void {
  try {
    socket?.close(CLOSE_CODE_NORMAL, reason)
  } catch (error) {
    consola.warn(`[upstream-ws] close(${CLOSE_CODE_NORMAL}) threw (ignored): ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function createUpstreamWsConnection(opts: CreateUpstreamWsConnectionOptions): UpstreamWsConnection {
  const createSocket = opts.createSocket ?? ((url, headers) => new WebSocket(url, { headers }))
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  let socket: WebSocketLike | null = null
  let busy = false
  /**
   * Synchronously marks the connection as unfit for reuse before the underlying
   * socket close event lands. Set on parse error / async errors observed while
   * the socket is technically still in OPEN state — a `findReusable` lookup
   * in the same tick must not return it. `isOpen` consults this flag so the
   * pool sees a single authoritative "available" signal.
   */
  let unusable = false
  let statefulMarker: string | undefined
  let currentQueue: AsyncQueue<ResponsesStreamEvent> | null = null
  let currentAbortCleanup: (() => void) | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * In-flight handshake promise. Set when connect() starts, cleared when it
   * settles (success or failure). A concurrent connect() call returns the same
   * promise instead of throwing — this is the right primitive because a
   * connection is meant to be acquired-then-used by a single caller, and any
   * "did the handshake finish?" question deserves the same answer.
   */
  let connectingPromise: Promise<void> | null = null

  const markUnusable = () => {
    unusable = true
  }

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  const scheduleIdleClose = () => {
    clearIdleTimer()
    if (!socket || busy || socket.readyState !== socket.OPEN || idleTimeoutMs <= 0) return
    idleTimer = setTimeout(
      guardCallback(
        () => {
          closeUpstreamWs(socket, "Idle timeout")
        },
        (error) => {
          consola.warn(`[upstream-ws] idle-timer callback threw (model=${opts.model}): ${toError(error).message}`)
          markUnusable()
        },
      ),
      idleTimeoutMs,
    )
  }

  const finishRequest = () => {
    busy = false
    currentAbortCleanup?.()
    currentAbortCleanup = null
    currentQueue?.close()
    currentQueue = null
    scheduleIdleClose()
  }

  const failRequest = (error: Error) => {
    busy = false
    currentAbortCleanup?.()
    currentAbortCleanup = null
    currentQueue?.fail(error)
    currentQueue = null
  }

  const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)))

  /**
   * Per-callback escape for the lifecycle / in-request listeners: a throw that
   * would otherwise escalate to `uncaughtException → process.exit(1)` is downgraded
   * to warn + mark the connection unusable + fail the in-flight request (Phase 3
   * recoverable). Must itself be throw-free (only warn + set flags + failRequest).
   */
  const onCallbackEscape = (error: unknown): void => {
    consola.warn(`[upstream-ws] callback threw; failing request + dropping connection (model=${opts.model}): ${toError(error).message}`)
    markUnusable()
    failRequest(toError(error))
  }

  const handleMessage = guardCallback((event: Event) => {
    if (!(event instanceof MessageEvent)) return
    if (!currentQueue) return

    clearIdleTimer()

    try {
      const parsed = parseWebSocketEvent(event.data)
      currentQueue.push(parsed)

      if (parsed.type === "response.completed") {
        statefulMarker = parsed.response.id
      }

      if (TERMINAL_EVENTS.has(parsed.type)) {
        finishRequest()
      }
    } catch (error) {
      consola.warn(`[upstream-ws] Frame parse error; dropping connection (model=${opts.model}): ${error instanceof Error ? error.message : String(error)}`)
      failRequest(error instanceof Error ? error : new Error(String(error)))
      // Parse error implies the upstream protocol state is dirty — the next frame
      // is likely also malformed. Mark unusable synchronously so any same-tick
      // findReusable() lookup ignores this connection, then drop the socket.
      markUnusable()
      closeUpstreamWs(socket, "Parse error")
    }
  }, onCallbackEscape)

  const handleError = guardCallback(() => {
    if (busy && currentQueue) {
      consola.warn(`[upstream-ws] Socket error mid-request (model=${opts.model}); failing request and dropping connection`)
      failRequest(new Error("Upstream WebSocket error"))
    }
    // Even when idle, an error means the socket state is suspect. Mark unusable
    // and actively close so the pool removes it now instead of waiting for the
    // close event — that latency window is where stale connections leak into
    // findReusable() and cause an extra fallback hop.
    markUnusable()
    closeUpstreamWs(socket, "Socket error")
  }, onCallbackEscape)

  let closeHandled = false
  const handleClose = guardCallback((event: Event) => {
    // Defensive re-entry guard: some WS implementations dispatch close more than
    // once (e.g. after an error). Reuse-of-stale-event would re-fire failRequest
    // with a stale reason and re-trigger opts.onClose, masking the real cause.
    if (closeHandled) return
    closeHandled = true

    clearIdleTimer()
    socket?.removeEventListener("message", handleMessage)
    socket?.removeEventListener("error", handleError)
    socket?.removeEventListener("close", handleClose)
    socket = null
    opts.onClose?.()

    if (!busy || !currentQueue) return

    const closeEvent = event as CloseEvent
    consola.warn(`[upstream-ws] Connection closed mid-request (${closeEvent.code}: ${closeEvent.reason || "unknown"}, model=${opts.model})`)
    failRequest(new Error(`Upstream WebSocket closed (${closeEvent.code}: ${closeEvent.reason || "unknown"})`))
  }, onCallbackEscape)

  return {
    connect(connectOpts) {
      // Already connected — fast path.
      if (socket && socket.readyState === socket.OPEN) return Promise.resolve()

      // Build (or join) the shared handshake promise. The shared promise itself
      // is NOT bound to any single caller's abort signal: if caller A aborts,
      // the underlying handshake still proceeds for caller B. Each caller then
      // races the shared promise against its own signal locally below.
      if (!connectingPromise) {
        const ws = createSocket(copilotWsUrl(state), opts.headers)

        connectingPromise = new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            ws.removeEventListener("open", onOpen)
            ws.removeEventListener("error", onOpenError)
          }

          const onOpen = guardCallback(
            () => {
              cleanup()
              // Only after a successful handshake do we (a) bind the long-lived
              // lifecycle listeners and (b) promote `ws` to the module-level
              // `socket`. A failed handshake leaves no shared state behind.
              socket = ws
              ws.addEventListener("message", handleMessage)
              ws.addEventListener("error", handleError)
              ws.addEventListener("close", handleClose)
              scheduleIdleClose()
              resolve()
            },
            (error) => {
              consola.warn(`[upstream-ws] handshake callback threw (model=${opts.model}): ${toError(error).message}`)
              cleanup()
              reject(toError(error))
            },
          )

          const onOpenError = guardCallback(
            () => {
              cleanup()
              closeUpstreamWs(ws, "Handshake failed")
              reject(new Error("Upstream WebSocket handshake failed"))
            },
            (error) => {
              consola.warn(`[upstream-ws] handshake callback threw (model=${opts.model}): ${toError(error).message}`)
              cleanup()
              reject(toError(error))
            },
          )

          ws.addEventListener("open", onOpen, { once: true })
          ws.addEventListener("error", onOpenError, { once: true })
        }).finally(() => {
          connectingPromise = null
        })
      }

      const handshake = connectingPromise
      const signal = connectOpts?.signal
      if (!signal) return handshake

      // Per-caller race: if THIS caller's signal aborts, they get an "aborted"
      // rejection without affecting the shared handshake (other joined callers
      // continue waiting for the real outcome).
      return new Promise<void>((resolve, reject) => {
        const onAbort = guardCallback(
          () => {
            signal.removeEventListener("abort", onAbort)
            reject(new Error("Upstream WebSocket connection aborted"))
          },
          (error) => {
            consola.warn(`[upstream-ws] handshake callback threw (model=${opts.model}): ${toError(error).message}`)
            signal.removeEventListener("abort", onAbort)
            reject(toError(error))
          },
        )
        if (signal.aborted) {
          reject(new Error("Upstream WebSocket connection aborted"))
          return
        }
        signal.addEventListener("abort", onAbort, { once: true })

        handshake.then(
          (value) => {
            signal.removeEventListener("abort", onAbort)
            resolve(value)
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort)
            reject(error as Error)
          },
        )
      })
    },

    sendRequest(payload, requestOpts) {
      if (!socket || socket.readyState !== socket.OPEN) {
        throw new Error("Upstream WebSocket is not connected")
      }
      if (busy) {
        throw new Error("Upstream WebSocket connection is busy")
      }

      clearIdleTimer()
      busy = true
      currentQueue = createAsyncQueue<ResponsesStreamEvent>()

      const abortSignal = requestOpts?.abortSignal
      const onAbort = guardCallback(() => {
        failRequest(new Error("Upstream WebSocket request aborted"))
      }, onCallbackEscape)

      currentAbortCleanup = () => {
        abortSignal?.removeEventListener("abort", onAbort)
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true })

      try {
        const { stream: _stream, ...wire } = payload
        socket.send(JSON.stringify({ type: "response.create", ...wire }))
      } catch (error) {
        consola.warn(`[upstream-ws] Send failed; dropping connection (model=${opts.model}): ${error instanceof Error ? error.message : String(error)}`)
        currentAbortCleanup()
        currentAbortCleanup = null
        failRequest(error instanceof Error ? error : new Error(String(error)))
        // A send failure leaves the protocol in an indeterminate state. Mark
        // the connection unusable synchronously so any same-tick reuse lookup
        // skips it, then tear down the socket.
        markUnusable()
        closeUpstreamWs(socket, "Send failed")
      }

      const queue = currentQueue

      return (async function* () {
        try {
          yield* queue.iterate()
        } finally {
          currentAbortCleanup?.()
          currentAbortCleanup = null
        }
      })()
    },

    get isOpen() {
      // `unusable` is the synchronous signal — see the field declaration for why.
      // Without it, parse/send/error handlers race the close event and a same-tick
      // findReusable() can hand out a connection that's already toast.
      return !unusable && socket !== null && socket.readyState === socket.OPEN
    },

    get isBusy() {
      return busy
    },

    get statefulMarker() {
      return statefulMarker
    },

    get model() {
      return opts.model
    },

    get conversationId() {
      return opts.conversationId
    },

    get handshakeHeaders() {
      return opts.headers
    },

    close() {
      clearIdleTimer()
      if (socket) {
        // Has a live or closing socket — close it; handleClose will fire the
        // onClose callback so the manager removes us from the pool.
        closeUpstreamWs(socket, "Going away")
      } else if (!closeHandled) {
        // No socket yet (handshake either in progress or never started) — we
        // still need to inform the manager so a placeholder created via
        // manager.create() does not linger in the pool forever. Mark as
        // unusable so any racing reuse lookup skips us.
        closeHandled = true
        markUnusable()
        opts.onClose?.()
      }
    },
  }
}

function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: Array<T> = []
  const waiters: Array<{
    resolve: (value: IteratorResult<T>) => void
    reject: (error: Error) => void
  }> = []
  let closed = false
  let failure: Error | null = null

  const drain = () => {
    while (waiters.length > 0) {
      if (failure) {
        waiters.shift()?.reject(failure)
        continue
      }
      if (values.length > 0) {
        waiters.shift()?.resolve({ done: false, value: values.shift() as T })
        continue
      }
      if (closed) {
        waiters.shift()?.resolve({ done: true, value: undefined })
        continue
      }
      break
    }
  }

  return {
    push(value) {
      if (closed || failure) return
      values.push(value)
      drain()
    },

    close() {
      closed = true
      drain()
    },

    fail(error) {
      if (failure) return
      failure = error
      drain()
    },

    async *iterate() {
      for (;;) {
        if (failure) throw failure
        if (values.length > 0) {
          yield values.shift() as T
          continue
        }
        if (closed) return

        const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
          waiters.push({ resolve, reject })
          drain()
        })

        if (next.done) return
        yield next.value
      }
    },
  }
}

function parseWebSocketEvent(input: unknown): ResponsesStreamEvent {
  let text: string | null = null
  if (typeof input === "string") {
    text = input
  } else if (input instanceof ArrayBuffer) {
    text = Buffer.from(input).toString("utf8")
  } else if (ArrayBuffer.isView(input)) {
    text = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("utf8")
  }

  if (text === null) {
    throw new Error("Unsupported upstream WebSocket frame")
  }

  const parsed = JSON.parse(text) as Record<string, unknown>
  if (isCapiWebSocketError(parsed)) {
    return {
      type: "error",
      code: parsed.error.code,
      message: parsed.error.message,
      sequence_number: typeof parsed.sequence_number === "number" ? parsed.sequence_number : 0,
    }
  }

  return parsed as unknown as ResponsesStreamEvent
}

export function isCapiWebSocketError(input: unknown): input is {
  type: "error"
  error: { code: string; message: string }
  sequence_number?: number
} {
  if (!input || typeof input !== "object") return false
  const record = input as Record<string, unknown>
  if (record.type !== "error") return false
  if (!record.error || typeof record.error !== "object") return false
  const error = record.error as Record<string, unknown>
  return typeof error.code === "string" && typeof error.message === "string"
}
