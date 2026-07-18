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
  private readonly errorWaiters = new Set<(error: Error) => void>()
  private failure: Error | undefined

  constructor(destination: PinoRollDestination) {
    super()
    // EventEmitter treats an unobserved `error` specially and throws. The
    // wrapper is a diagnostic boundary, so standalone use must remain
    // never-throw; owners may still add their own error listener.
    this.on("error", () => {})
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
      this.fail(new Error(`Diagnostic destination dropped ${bytes} bytes`))
      this.resolveIdleIfNeeded()
    })
    destination.on("error", (error) => {
      this.emit("error", error)
      this.fail(error)
    })
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
    if (this.failure) return Promise.reject(this.failure)
    if (this.queued === 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.idleWaiters.add(resolve)
      this.errorWaiters.add(reject)
    })
  }

  private resolveIdleIfNeeded(): void {
    if (this.queued !== 0) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
    this.errorWaiters.clear()
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const reject of this.errorWaiters) reject(error)
    this.errorWaiters.clear()
    this.idleWaiters.clear()
  }
}
