import { WebSocket } from "undici"

import type { ResponsesPayload, ResponsesStreamEvent } from "~/types/api/openai-responses"

import { copilotWsUrl } from "~/lib/copilot-api"
import { state } from "~/lib/state"

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000
const CLOSE_CODE_GOING_AWAY = 1001
const TERMINAL_EVENTS = new Set(["response.completed", "response.failed", "response.incomplete", "error"])

export interface CreateUpstreamWsConnectionOptions {
  headers: Record<string, string>
  model: string
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
  close(): void
}

interface AsyncQueue<T> {
  push(value: T): void
  close(): void
  fail(error: Error): void
  iterate(): AsyncGenerator<T>
}

export function createUpstreamWsConnection(opts: CreateUpstreamWsConnectionOptions): UpstreamWsConnection {
  const createSocket = opts.createSocket ?? ((url, headers) => new WebSocket(url, { headers }))
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  let socket: WebSocketLike | null = null
  let busy = false
  let statefulMarker: string | undefined
  let currentQueue: AsyncQueue<ResponsesStreamEvent> | null = null
  let currentAbortCleanup: (() => void) | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  const scheduleIdleClose = () => {
    clearIdleTimer()
    if (!socket || busy || socket.readyState !== socket.OPEN || idleTimeoutMs <= 0) return
    idleTimer = setTimeout(() => {
      socket?.close(CLOSE_CODE_GOING_AWAY, "Idle timeout")
    }, idleTimeoutMs)
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

  const handleMessage = (event: Event) => {
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
      failRequest(error instanceof Error ? error : new Error(String(error)))
    }
  }

  const handleError = () => {
    if (!busy || !currentQueue) return
    failRequest(new Error("Upstream WebSocket error"))
  }

  const handleClose = (event: Event) => {
    clearIdleTimer()
    socket?.removeEventListener("message", handleMessage)
    socket?.removeEventListener("error", handleError)
    socket?.removeEventListener("close", handleClose)
    socket = null
    opts.onClose?.()

    if (!busy || !currentQueue) return

    const closeEvent = event as CloseEvent
    failRequest(new Error(`Upstream WebSocket closed (${closeEvent.code}: ${closeEvent.reason || "unknown"})`))
  }

  return {
    async connect(connectOpts) {
      const existingSocket = socket
      if (existingSocket && existingSocket.readyState === existingSocket.OPEN) return
      if (existingSocket && existingSocket.readyState === existingSocket.CONNECTING) {
        throw new Error("Upstream WebSocket is already connecting")
      }

      const ws = createSocket(copilotWsUrl(state), opts.headers)
      socket = ws
      ws.addEventListener("message", handleMessage)
      ws.addEventListener("error", handleError)
      ws.addEventListener("close", handleClose)

      await new Promise<void>((resolve, reject) => {
        const signal = connectOpts?.signal
        const activeSocket = ws

        const cleanup = () => {
          activeSocket.removeEventListener("open", onOpen)
          activeSocket.removeEventListener("error", onOpenError)
          signal?.removeEventListener("abort", onAbort)
        }

        const onOpen = () => {
          cleanup()
          resolve()
        }

        const onOpenError = () => {
          cleanup()
          activeSocket.close(CLOSE_CODE_GOING_AWAY, "Handshake failed")
          reject(new Error("Upstream WebSocket handshake failed"))
        }

        const onAbort = () => {
          cleanup()
          activeSocket.close(CLOSE_CODE_GOING_AWAY, "Aborted")
          reject(new Error("Upstream WebSocket connection aborted"))
        }

        activeSocket.addEventListener("open", onOpen, { once: true })
        activeSocket.addEventListener("error", onOpenError, { once: true })
        signal?.addEventListener("abort", onAbort, { once: true })

        if (signal?.aborted) onAbort()
      })

      scheduleIdleClose()
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
      const onAbort = () => {
        failRequest(new Error("Upstream WebSocket request aborted"))
      }

      currentAbortCleanup = () => {
        abortSignal?.removeEventListener("abort", onAbort)
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true })

      try {
        const { stream: _stream, ...wire } = payload
        socket.send(JSON.stringify({ type: "response.create", ...wire }))
      } catch (error) {
        currentAbortCleanup()
        currentAbortCleanup = null
        failRequest(error instanceof Error ? error : new Error(String(error)))
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
      return socket !== null && socket.readyState === socket.OPEN
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

    close() {
      clearIdleTimer()
      socket?.close(CLOSE_CODE_GOING_AWAY, "Going away")
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
