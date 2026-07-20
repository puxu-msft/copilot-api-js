import type { ObservabilityEvent } from "./events"

export type StreamProgressEvent = Extract<ObservabilityEvent, { kind: "request.stream_progress" }>

export interface StreamProgressCoalescerOptions {
  intervalMs?: number
  deliver: (event: StreamProgressEvent) => void
}

/** Presentation-only latest-value coalescer; canonical counters stay at producers. */
export class StreamProgressCoalescer {
  private readonly intervalMs: number
  private readonly deliver: (event: StreamProgressEvent) => void
  private readonly latest = new Map<string, StreamProgressEvent>()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(options: StreamProgressCoalescerOptions) {
    this.intervalMs = Math.max(1, options.intervalMs ?? 75)
    this.deliver = options.deliver
  }

  push(event: StreamProgressEvent): void {
    this.latest.set(event.ctx.id, event)
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.intervalMs)
    this.timer.unref()
  }

  flush(requestId?: string): void {
    if (requestId !== undefined) {
      const event = this.latest.get(requestId)
      this.latest.delete(requestId)
      if (event) this.deliver(event)
      if (this.latest.size === 0) this.clearTimer()
      return
    }
    const events = [...this.latest.values()]
    this.latest.clear()
    this.clearTimer()
    for (const event of events) this.deliver(event)
  }

  destroy(): void {
    this.flush()
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
