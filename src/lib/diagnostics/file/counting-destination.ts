import type { PinoRollDestination } from "pino-roll"

import { EventEmitter } from "node:events"

import type { DiagnosticDestinationHealth } from "./types"

/** Publicly-owned accounting wrapper; never reads SonicBoom private fields. */
// eslint-disable-next-line unicorn/prefer-event-target -- Pino DestinationStream uses Node EventEmitter semantics.
export class CountingDestination extends EventEmitter {
  private readonly destination: PinoRollDestination
  private accepted = 0
  private queued = 0
  private written = 0
  private dropped = 0
  private readonly dirtyPaths = new Set<string>()
  private readonly settlementWaiters = new Set<{ targetBytes: number; resolve: () => void; reject: (error: Error) => void }>()
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
      this.resolveSettledWaiters()
    })
    destination.on("drop", (data) => {
      const bytes = Buffer.byteLength(data)
      this.dropped += bytes
      this.queued = Math.max(0, this.queued - bytes)
      this.fail(new Error(`Diagnostic destination dropped ${bytes} bytes`))
      this.emit("drop", data)
      this.resolveSettledWaiters()
    })
    destination.on("error", (error) => {
      this.fail(error)
      this.emit("error", error)
    })
  }

  write(data: string): boolean {
    const bytes = Buffer.byteLength(data)
    this.accepted += bytes
    this.queued += bytes
    try {
      return this.destination.write(data)
    } catch (error) {
      this.accepted -= bytes
      this.queued -= bytes
      const failure = error instanceof Error ? error : new Error(String(error))
      this.fail(failure)
      this.emit("error", failure)
      throw error
    }
  }

  get health(): DiagnosticDestinationHealth {
    return {
      acceptedBytes: this.accepted,
      settledBytes: this.written + this.dropped,
      queuedBytes: this.queued,
      writtenBytes: this.written,
      droppedBytes: this.dropped,
    }
  }

  get failureReason(): Error | undefined {
    return this.failure
  }

  takeDirtyPaths(): Array<string> {
    const paths = [...this.dirtyPaths]
    this.dirtyPaths.clear()
    return paths
  }

  waitForSettled(targetBytes: number): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.written + this.dropped >= targetBytes) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.settlementWaiters.add({ targetBytes, resolve, reject })
    })
  }

  private resolveSettledWaiters(): void {
    const settledBytes = this.written + this.dropped
    for (const waiter of this.settlementWaiters) {
      if (settledBytes < waiter.targetBytes) continue
      this.settlementWaiters.delete(waiter)
      waiter.resolve()
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const waiter of this.settlementWaiters) waiter.reject(error)
    this.settlementWaiters.clear()
  }
}
