import type { Writable } from "node:stream"

import { writeEmergencyFallback } from "~/lib/diagnostics/emergency-output"

export interface OutputArbiterOptions {
  maxQueuedLines?: number
}

/** Sole stdout side-effect owner with bounded line buffering and repaint coalescing. */
export class OutputArbiter {
  private readonly stream: NodeJS.WritableStream
  private readonly maxQueuedLines: number
  private readonly lineQueue: Array<string> = []
  private latestRepaint: string | undefined
  private backpressured = false
  private isFaulted = false
  private onFaultCallback: (() => void) | undefined
  private readonly drainWaiters = new Set<() => void>()
  private readonly sensitive = new Set<string>()
  private readonly onStreamFault = (): void => this.fault()
  private readonly onDrain = (): void => this.flush()
  private dropped = 0

  constructor(stream: NodeJS.WritableStream, options: OutputArbiterOptions = {}) {
    this.stream = stream
    this.maxQueuedLines = Math.max(1, options.maxQueuedLines ?? 200)
    const writable = stream as Partial<Writable>
    writable.on?.("error", this.onStreamFault)
    writable.on?.("close", this.onStreamFault)
    writable.on?.("drain", this.onDrain)
  }

  get faulted(): boolean {
    return this.isFaulted
  }
  get droppedLines(): number {
    return this.dropped
  }

  setOnFault(callback: () => void): void {
    this.onFaultCallback = callback
    if (this.isFaulted) this.notifyFault(callback)
  }

  /** Compatibility alias for a coalescible terminal frame. */
  write(data: string): boolean {
    return this.writeFrame(data)
  }

  writeFrame(data: string): boolean {
    if (!this.canWrite()) return false
    if (this.backpressured || this.lineQueue.length > 0) {
      this.latestRepaint = data
      return true
    }
    return this.writeNow(data)
  }

  writeLine(data: string): boolean {
    if (!this.canWrite()) return false
    if (!this.backpressured && this.lineQueue.length === 0 && this.latestRepaint === undefined) return this.writeNow(data)
    if (this.lineQueue.length >= this.maxQueuedLines) {
      this.lineQueue.shift()
      this.dropped++
    }
    this.lineQueue.push(data)
    return true
  }

  writeSensitiveOnce(data: string): boolean {
    if (this.sensitive.has(data)) return false
    const written = this.writeLine(data)
    if (written) this.sensitive.add(data)
    return written
  }

  drain(): Promise<void> {
    if (this.isFaulted || (!this.backpressured && this.lineQueue.length === 0 && this.latestRepaint === undefined)) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.add(resolve))
  }

  destroy(): void {
    const writable = this.stream as Partial<Writable>
    writable.removeListener?.("error", this.onStreamFault)
    writable.removeListener?.("close", this.onStreamFault)
    writable.removeListener?.("drain", this.onDrain)
    this.resolveDrainWaiters()
  }

  private canWrite(): boolean {
    const writable = this.stream as Partial<Writable>
    if (this.isFaulted || writable.destroyed || writable.writableEnded) {
      this.fault()
      return false
    }
    return true
  }

  private writeNow(data: string): boolean {
    try {
      const accepted = this.stream.write(data)
      this.backpressured = !accepted
      if (accepted) this.resolveDrainWaitersIfIdle()
      return true
    } catch {
      this.fault()
      return false
    }
  }

  private flush(): void {
    if (this.isFaulted) return
    this.backpressured = false
    while (this.lineQueue.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- writeNow mutates this flag after each stream.write.
      if (this.backpressured) break
      const line = this.lineQueue.shift()
      if (line !== undefined) this.writeNow(line)
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the preceding writeNow calls mutate this flag.
    if (!this.backpressured && this.latestRepaint !== undefined) {
      const repaint = this.latestRepaint
      this.latestRepaint = undefined
      this.writeNow(repaint)
    }
    this.resolveDrainWaitersIfIdle()
  }

  private resolveDrainWaitersIfIdle(): void {
    if (!this.backpressured && this.lineQueue.length === 0 && this.latestRepaint === undefined) this.resolveDrainWaiters()
  }

  private resolveDrainWaiters(): void {
    for (const resolve of this.drainWaiters) resolve()
    this.drainWaiters.clear()
  }

  private fault(): void {
    if (this.isFaulted) return
    this.isFaulted = true
    this.lineQueue.length = 0
    this.latestRepaint = undefined
    this.resolveDrainWaiters()
    if (this.onFaultCallback) this.notifyFault(this.onFaultCallback)
    writeEmergencyFallback("[terminal] output stream unavailable; terminal rendering disabled")
  }

  private notifyFault(callback: () => void): void {
    try {
      callback()
    } catch {
      /* fault handling must not escape into producers */
    }
  }
}
