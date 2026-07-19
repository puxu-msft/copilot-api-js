import type { PinoRollDestination } from "pino-roll"

import fs from "node:fs"
import path from "node:path"

import type {
  //
  DiagnosticWriterHealth,
  DiagnosticWriterState,
  SyncDiagnosticSegments,
} from "./types"

import { CountingDestination } from "./counting-destination"
import { listDiagnosticSegments } from "./segment-files"

interface DurableFileWriterOptions {
  syncSegments?: SyncDiagnosticSegments
  listSegments?: (baseName: string) => Array<string>
}

const MAX_SEGMENT_STABILITY_ATTEMPTS = 8

/**
 * Owns the durability and terminal lifecycle of one structured diagnostic
 * destination. It deliberately knows nothing about Pino records or the
 * observability bus: callers provide serialized writes through `output` and a
 * single shutdown marker callback.
 */
export class DurableFileWriter {
  readonly output: CountingDestination

  private readonly destination: PinoRollDestination
  private readonly baseName: string
  private state: DiagnosticWriterState = "starting"
  private lastError: Error | undefined
  private checkpointTail: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | undefined
  private readonly syncSegments: SyncDiagnosticSegments
  private readonly listSegments: (baseName: string) => Array<string>

  constructor(destination: PinoRollDestination, output: CountingDestination, baseName: string, options: DurableFileWriterOptions = {}) {
    this.destination = destination
    this.output = output
    this.baseName = baseName
    this.syncSegments = options.syncSegments ?? syncDiagnosticSegments
    this.listSegments = options.listSegments ?? listDiagnosticSegments
    output.on("drop", () => this.markDegraded(output.failureReason ?? new Error("Diagnostic destination dropped data")))
    output.on("error", (error: Error) => this.markDegraded(error))
    this.state = "ready"
  }

  get health(): DiagnosticWriterHealth {
    return {
      state: this.state,
      activePath: this.destination.file,
      ...this.output.health,
      ...(this.lastError && { lastError: this.lastError }),
    }
  }

  /** Record a failure owned by the sink layer, such as retention or serialization. */
  recordFailure(error: unknown): void {
    this.markDegraded(asError(error))
  }

  /**
   * Durably checkpoint every byte accepted before this call.
   *
   * SonicBoom 4.2 can resolve a flush after its active write while retaining a
   * newly queued tail below `minLength`. The public byte counter is therefore
   * the completion oracle: keep flushing while each callback makes progress,
   * then fsync every segment that can contain this writer's data.
   */
  durable(): Promise<void> {
    const targetBytes = this.output.health.acceptedBytes
    const checkpoint = this.checkpointTail.then(() => this.durableTarget(targetBytes))
    this.checkpointTail = checkpoint.catch(() => {})
    return checkpoint
  }

  private async durableTarget(targetBytes: number): Promise<void> {
    if (this.state === "closed") return
    if (this.state === "failed") throw this.lastError ?? new Error("Diagnostic writer failed")
    const failures: Array<unknown> = []
    try {
      await this.drainAcceptedBytes(targetBytes)
    } catch (error) {
      failures.push(error)
    }
    if (this.output.health.settledBytes >= targetBytes) {
      try {
        await this.output.waitForSettled(targetBytes)
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      await this.syncStableSegments(this.output.takeDirtyPaths())
    } catch (error) {
      failures.push(error)
    }
    if (this.output.failureReason) failures.push(this.output.failureReason)
    if (this.lastError) failures.push(this.lastError)
    const uniqueFailures = [...new Set(failures)]
    if (uniqueFailures.length === 0) return
    const failure = uniqueFailures.length === 1 ? asError(uniqueFailures[0]) : new AggregateError(uniqueFailures, "Diagnostic durability failed")
    this.markDegraded(failure)
    throw failure
  }

  /**
   * Seal exactly once: ordinary data durable, marker durable, destination end,
   * and close observed. Concurrent callers share the same terminal promise.
   */
  close(writeMarker: () => void): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.state = "sealing"
    this.closePromise = this.closeOnce(writeMarker)
    return this.closePromise
  }

  private async closeOnce(writeMarker: () => void): Promise<void> {
    const failures: Array<unknown> = []

    try {
      await this.durable()
    } catch (error) {
      failures.push(error)
    }

    const droppedBeforeMarker = this.output.health.droppedBytes
    try {
      writeMarker()
      if (this.output.health.droppedBytes !== droppedBeforeMarker) throw new Error("Diagnostic shutdown marker was dropped")
      await this.durable()
    } catch (error) {
      failures.push(error)
    }

    try {
      await this.endAndWaitForClose()
    } catch (error) {
      failures.push(error)
    }

    if (failures.length > 0) {
      const uniqueFailures = [...new Set(failures)]
      const failure = uniqueFailures.length === 1 ? asError(uniqueFailures[0]) : new AggregateError(uniqueFailures, "Diagnostic writer shutdown failed")
      this.lastError = failure
      this.state = "failed"
      throw failure
    }

    this.state = "closed"
  }

  private async drainAcceptedBytes(targetBytes: number): Promise<void> {
    let settledBefore = this.output.health.settledBytes
    while (settledBefore < targetBytes) {
      await flushDestination(this.destination)
      const settledAfter = this.output.health.settledBytes
      if (settledAfter <= settledBefore) {
        throw new Error(`Diagnostic durability made no progress: ${targetBytes - settledAfter} target byte(s) remain unsettled after flush`)
      }
      settledBefore = settledAfter
    }
  }

  private endAndWaitForClose(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onClose = () => {
        this.destination.removeListener("error", onError)
        resolve()
      }
      const onError = (error: Error) => {
        this.destination.removeListener("close", onClose)
        reject(error)
      }
      this.destination.once("close", onClose)
      this.destination.once("error", onError)
      this.destination.end()
    })
  }

  private async syncStableSegments(initialDirtyPaths: ReadonlyArray<string>): Promise<void> {
    let dirtyPaths = [...initialDirtyPaths]
    for (let attempt = 0; attempt < MAX_SEGMENT_STABILITY_ATTEMPTS; attempt++) {
      await yieldEventLoopTurn()
      const pathBefore = this.destination.file
      const segmentsBefore = this.listSegments(this.baseName).sort()
      await this.syncSegments(this.baseName, [...new Set([...dirtyPaths, ...segmentsBefore])])
      await yieldEventLoopTurn()
      const pathAfter = this.destination.file
      const segmentsAfter = this.listSegments(this.baseName).sort()
      if (pathAfter === pathBefore && arraysEqual(segmentsAfter, segmentsBefore)) return
      dirtyPaths = [...new Set([...dirtyPaths, ...segmentsAfter])]
    }
    throw new Error(`Diagnostic segment generation did not stabilize after ${MAX_SEGMENT_STABILITY_ATTEMPTS} fsync attempt(s)`)
  }

  private markDegraded(error: Error): void {
    this.lastError ??= error
    if (this.state === "ready") this.state = "degraded"
  }
}

function flushDestination(destination: PinoRollDestination): Promise<void> {
  return new Promise((resolve, reject) => {
    destination.flush((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function syncDiagnosticSegments(baseName: string, dirtyPaths: ReadonlyArray<string>): Promise<void> {
  await Promise.all(
    dirtyPaths.map(async (file) => {
      const handle = await fs.promises.open(file, "r")
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }),
  )
  const directory = await fs.promises.open(path.dirname(baseName), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function yieldEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function arraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
