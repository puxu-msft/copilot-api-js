import type {
  //
  HistoryWorkerReady,
  WorkerGeneration,
} from "~/lib/history/worker/protocol"
import type { HistoryWorkerTransport } from "~/lib/history/worker/runtime"

import { HISTORY_WORKER_PROTOCOL_VERSION } from "~/lib/history/worker/protocol"

/**
 * A Worker transport whose every reply the test writes by hand.
 *
 * This is NOT a second implementation of the Worker: it answers nothing on its own, so it
 * can never be accidentally friendlier than the real thing. It exists to forge traffic a
 * correct Worker would never send — a retired generation's ACK, a `fatal` at a chosen
 * instant — which is unreachable through the real backend.
 */
export class ScriptedTransport implements HistoryWorkerTransport {
  readonly sent: Array<Record<string, unknown>> = []
  readonly generation: WorkerGeneration
  private readonly messageListeners = new Set<(value: unknown) => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()
  private readonly exitListeners = new Set<(code: number) => void>()

  constructor(generation: WorkerGeneration) {
    this.generation = generation
  }

  send(message: unknown): void {
    this.sent.push(message as Record<string, unknown>)
  }

  on(event: "message", listener: (value: unknown) => void): this
  on(event: "error", listener: (error: Error) => void): this
  on(event: "exit", listener: (code: number) => void): this
  on(event: "message" | "error" | "exit", listener: (value: never) => void): this {
    if (event === "message") this.messageListeners.add(listener as (value: unknown) => void)
    if (event === "error") this.errorListeners.add(listener as (error: Error) => void)
    if (event === "exit") this.exitListeners.add(listener as (code: number) => void)
    return this
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }

  emit(message: Record<string, unknown>): void {
    for (const listener of this.messageListeners) listener(structuredClone(message))
  }

  /** A thread that died without saying `fatal` — the recoverable case. */
  emitExit(code: number): void {
    for (const listener of this.exitListeners) listener(code)
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error)
  }

  /** Reply to the `initialize` this transport received, at the revision it was asked for. */
  emitReady(overrides: Partial<HistoryWorkerReady> = {}): void {
    const initialize = this.sent.find((message) => message.type === "initialize")
    if (!initialize) throw new Error("ScriptedTransport received no initialize to answer")
    const configRevision = (initialize.config as { configRevision: number }).configRevision
    this.emit({
      type: "ready",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: this.generation,
      requestId: initialize.requestId,
      ready: {
        workerGeneration: this.generation,
        threadId: 7,
        selectedDriver: "bun:sqlite",
        configRevision,
        rawTarget: { configRevision, requested: false, maxObjectBytes: 1024 },
        recoveredJournalOperations: 0,
        ...overrides,
      },
    })
  }

  emitFatal(error: string): void {
    this.emit({ type: "fatal", protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION, workerGeneration: this.generation, error })
  }

  emitPersistResult(messageId: number, outcome: string, generation = this.generation): void {
    this.emit({ type: "persist-result", protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION, workerGeneration: generation, messageId, outcome })
  }
}
