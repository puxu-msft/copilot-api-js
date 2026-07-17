import type { PinoRollDestination } from "pino-roll"

import { EventEmitter } from "node:events"

/** Publicly-owned accounting wrapper; never reads SonicBoom private fields. */
// eslint-disable-next-line unicorn/prefer-event-target -- Pino DestinationStream uses Node EventEmitter semantics.
export class CountingDestination extends EventEmitter {
  private readonly destination: PinoRollDestination
  private queued = 0
  private written = 0
  private dropped = 0
  private readonly dirtyPaths = new Set<string>()
  private readonly idleWaiters = new Set<() => void>()

  constructor(destination: PinoRollDestination) {
    super()
    this.destination = destination
    destination.on("write", (bytes) => {
      this.written += bytes
      this.queued = Math.max(0, this.queued - bytes)
      if (destination.file) this.dirtyPaths.add(destination.file)
      this.resolveIdleIfNeeded()
    })
    destination.on("drop", (data) => {
      const bytes = Buffer.byteLength(data)
      this.dropped += bytes
      this.queued = Math.max(0, this.queued - bytes)
      this.emit("drop", data)
      this.resolveIdleIfNeeded()
    })
    destination.on("error", (error) => this.emit("error", error))
  }

  write(data: string): boolean {
    this.queued += Buffer.byteLength(data)
    return this.destination.write(data)
  }

  flush(callback?: (error?: Error | null) => void): void {
    this.destination.flush(callback)
  }

  end(): void {
    this.destination.end()
  }

  get health(): { queuedBytes: number; writtenBytes: number; droppedBytes: number } {
    return { queuedBytes: this.queued, writtenBytes: this.written, droppedBytes: this.dropped }
  }

  takeDirtyPaths(): Array<string> {
    const paths = [...this.dirtyPaths]
    this.dirtyPaths.clear()
    return paths
  }

  waitForIdle(): Promise<void> {
    if (this.queued === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  private resolveIdleIfNeeded(): void {
    if (this.queued !== 0) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}
