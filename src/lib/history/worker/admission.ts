import type {
  //
  HistoryMessageId,
  HistoryOperationEnvelope,
  HistoryPersistenceOutcome,
} from "./protocol"

import { estimateHistoryEnvelopeBytes } from "./protocol"

export interface HistoryTerminalSink {
  enqueue(envelope: HistoryOperationEnvelope, onOutcome: (outcome: HistoryPersistenceOutcome) => void): HistoryMessageId
}

export interface HistoryReservation {
  readonly reservationId: string
  readonly admittedAt: number
  readonly historyAdmissionWaitMs: number
  bindOperationId(operationId: string): void
  releaseBeforeBinding(reason: string): void
}

export interface HistoryAdmissionStatus {
  readonly capacity: number
  readonly reserved: number
  readonly unacked: number
  readonly waiting: number
  readonly estimatedBytes: number
  readonly overCapacity: boolean
  readonly preTerminalFailuresTotal: number
  readonly lastPreTerminalError?: string
}

export interface HistoryAdmissionController {
  acquire(input: { signal: AbortSignal }): Promise<HistoryReservation>
  acceptTerminal(envelope: HistoryOperationEnvelope): Promise<HistoryPersistenceOutcome>
  failBeforeTerminal(operationId: string, error: unknown): void
  updateCapacity(capacity: number): void
  pause(reason: string): Promise<void>
  waitForQuiescence(): Promise<void>
  resume(): void
  replaceTerminalSink(sink: HistoryTerminalSink): void
  close(error: Error): void
  snapshot(): HistoryAdmissionStatus
}

interface WaitingAcquire {
  readonly queuedAt: number
  readonly signal: AbortSignal
  readonly resolve: (reservation: HistoryReservation) => void
  readonly reject: (error: unknown) => void
  readonly onAbort: () => void
  drainWhilePaused: boolean
}

type ReservationPhase = "unbound" | "bound" | "unacked" | "released"

interface ReservationRecord {
  readonly reservationId: string
  readonly admittedAt: number
  readonly historyAdmissionWaitMs: number
  phase: ReservationPhase
  operationId?: string
  estimatedBytes: number
}

export interface HistoryAdmissionControllerOptions {
  readonly capacity: number
  readonly sink: HistoryTerminalSink
  readonly now?: () => number
}

export class HistoryAdmissionControllerImpl implements HistoryAdmissionController {
  private capacity: number
  private sink: HistoryTerminalSink
  private readonly now: () => number
  private readonly waiters: Array<WaitingAcquire> = []
  private readonly operations = new Map<string, ReservationRecord>()
  private readonly pauseWaiters = new Set<() => void>()
  private readonly quiescenceWaiters = new Set<() => void>()
  private nextReservationId = 1
  private preTerminalFailuresTotal = 0
  private reserved = 0
  private unacked = 0
  private estimatedBytes = 0
  private closedError: Error | undefined
  private lastPreTerminalError: string | undefined
  private paused = false

  constructor(options: HistoryAdmissionControllerOptions) {
    assertCapacity(options.capacity)
    this.capacity = options.capacity
    this.sink = options.sink
    this.now = options.now ?? Date.now
  }

  acquire(input: { signal: AbortSignal }): Promise<HistoryReservation> {
    if (this.closedError) return Promise.reject(this.closedError)
    if (input.signal.aborted) return Promise.reject(abortReason(input.signal))
    const queuedAt = this.now()
    if (!this.paused && this.reserved < this.capacity) return Promise.resolve(this.admit(queuedAt))

    return new Promise<HistoryReservation>((resolve, reject) => {
      const waiter: WaitingAcquire = {
        queuedAt,
        signal: input.signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter)
          if (index === -1) return
          this.waiters.splice(index, 1)
          input.signal.removeEventListener("abort", waiter.onAbort)
          reject(abortReason(input.signal))
          this.resolvePauseIfDrained()
        },
        drainWhilePaused: false,
      }
      this.waiters.push(waiter)
      input.signal.addEventListener("abort", waiter.onAbort, { once: true })
    })
  }

  acceptTerminal(envelope: HistoryOperationEnvelope): Promise<HistoryPersistenceOutcome> {
    const operationId = envelope.publication.record.identity.operationId
    const record = this.operations.get(operationId)
    if (!record) return Promise.reject(new Error(`Unknown operation: ${operationId}`))
    if (record.phase === "unacked") return Promise.reject(new Error(`History operation already accepted: ${operationId}`))
    if (record.phase !== "bound") return Promise.reject(new Error(`History operation is not bound: ${operationId}`))

    record.phase = "unacked"
    record.estimatedBytes = estimateHistoryEnvelopeBytes(envelope)
    this.unacked++
    this.estimatedBytes += record.estimatedBytes

    return new Promise<HistoryPersistenceOutcome>((resolve, reject) => {
      const settlement = { done: false }
      const onOutcome = (outcome: HistoryPersistenceOutcome): void => {
        if (settlement.done) return
        settlement.done = true
        this.releaseRecord(record)
        resolve(outcome)
      }
      try {
        this.sink.enqueue(envelope, onOutcome)
      } catch (error) {
        if (settlement.done) return
        settlement.done = true
        this.releaseRecord(record)
        reject(asError(error, "History terminal sink failed"))
      }
    })
  }

  failBeforeTerminal(operationId: string, error: unknown): void {
    const record = this.operations.get(operationId)
    if (!record) throw new Error(`Unknown operation: ${operationId}`)
    if (record.phase !== "bound") throw new Error(`History operation already accepted: ${operationId}`)
    this.preTerminalFailuresTotal++
    this.lastPreTerminalError = error instanceof Error ? error.message : String(error)
    this.releaseRecord(record)
  }

  updateCapacity(capacity: number): void {
    assertCapacity(capacity)
    this.capacity = capacity
    this.admitWaiters()
  }

  pause(_reason: string): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError)
    if (!this.paused) {
      this.paused = true
      for (const waiter of this.waiters) waiter.drainWhilePaused = true
    }
    if (!this.waiters.some((waiter) => waiter.drainWhilePaused)) return Promise.resolve()
    const promise = new Promise<void>((resolve) => this.pauseWaiters.add(resolve))
    this.admitWaiters()
    return promise
  }

  waitForQuiescence(): Promise<void> {
    if (this.reserved === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.quiescenceWaiters.add(resolve))
  }

  resume(): void {
    if (this.closedError) throw this.closedError
    this.paused = false
    this.admitWaiters()
  }

  replaceTerminalSink(sink: HistoryTerminalSink): void {
    this.sink = sink
  }

  close(error: Error): void {
    if (this.closedError) return
    this.closedError = error
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.onAbort)
      waiter.reject(error)
    }
    this.resolvePauseIfDrained()
  }

  snapshot(): HistoryAdmissionStatus {
    return {
      capacity: this.capacity,
      reserved: this.reserved,
      unacked: this.unacked,
      waiting: this.waiters.length,
      estimatedBytes: this.estimatedBytes,
      overCapacity: this.reserved > this.capacity,
      preTerminalFailuresTotal: this.preTerminalFailuresTotal,
      ...(this.lastPreTerminalError !== undefined && { lastPreTerminalError: this.lastPreTerminalError }),
    }
  }

  private admit(queuedAt: number): HistoryReservation {
    const admittedAt = this.now()
    const record: ReservationRecord = {
      reservationId: `history-reservation-${this.nextReservationId++}`,
      admittedAt,
      historyAdmissionWaitMs: Math.max(0, admittedAt - queuedAt),
      phase: "unbound",
      estimatedBytes: 0,
    }
    this.reserved++

    return {
      reservationId: record.reservationId,
      admittedAt: record.admittedAt,
      historyAdmissionWaitMs: record.historyAdmissionWaitMs,
      bindOperationId: (operationId) => this.bindOperation(record, operationId),
      releaseBeforeBinding: (_reason) => {
        if (record.phase === "released") throw new Error(`History reservation already released: ${record.reservationId}`)
        if (record.phase !== "unbound") throw new Error(`History reservation is already bound: ${record.reservationId}`)
        this.releaseRecord(record)
      },
    }
  }

  private bindOperation(record: ReservationRecord, operationId: string): void {
    if (record.phase === "released") throw new Error(`History reservation already released: ${record.reservationId}`)
    if (record.phase !== "unbound") throw new Error(`History reservation is already bound: ${record.reservationId}`)
    if (this.operations.has(operationId)) throw new Error(`History operation is already bound: ${operationId}`)
    record.phase = "bound"
    record.operationId = operationId
    this.operations.set(operationId, record)
  }

  private releaseRecord(record: ReservationRecord): void {
    if (record.phase === "released") throw new Error(`History reservation already released: ${record.reservationId}`)
    if (record.phase === "unacked") {
      this.unacked--
      this.estimatedBytes -= record.estimatedBytes
    }
    if (record.operationId) this.operations.delete(record.operationId)
    record.phase = "released"
    this.reserved--
    this.admitWaiters()
    if (this.reserved === 0) {
      for (const resolve of this.quiescenceWaiters) resolve()
      this.quiescenceWaiters.clear()
    }
  }

  private admitWaiters(): void {
    if (this.closedError) return
    while (this.reserved < this.capacity && this.waiters.length > 0) {
      const waiter = this.waiters[0]
      if (this.paused && !waiter.drainWhilePaused) break
      this.waiters.shift()
      waiter.signal.removeEventListener("abort", waiter.onAbort)
      if (waiter.signal.aborted) {
        waiter.reject(abortReason(waiter.signal))
        continue
      }
      waiter.resolve(this.admit(waiter.queuedAt))
    }
    this.resolvePauseIfDrained()
  }

  private resolvePauseIfDrained(): void {
    if (this.waiters.some((waiter) => waiter.drainWhilePaused)) return
    for (const resolve of this.pauseWaiters) resolve()
    this.pauseWaiters.clear()
  }
}

function assertCapacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new RangeError("History admission capacity must be a positive safe integer")
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError")
}

function asError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}
