import { Worker } from "node:worker_threads"

import type {
  //
  HistoryDrainResult,
  HistoryMessageId,
  HistoryOperationEnvelope,
  HistoryPersistenceOutcome,
  HistoryWorkerHotConfig,
  HistoryWorkerReady,
  HistoryWorkerStartConfig,
  HistoryWorkerStatus,
  HistoryWorkerToMainMessage,
  MainToHistoryWorkerMessage,
  RawTargetDescriptor,
  WorkerGeneration,
} from "./protocol"

import {
  //
  HISTORY_WORKER_PROTOCOL_VERSION,
  HistoryWorkerProtocolError,
  assertStructuredCloneSafe,
  createRawTargetDescriptor,
  detectHistorySqliteDriver,
  parseMainToWorkerMessage,
  parseWorkerToMainMessage,
} from "./protocol"

const DEFAULT_TOMBSTONE_CAPACITY = 256

export interface HistoryWorkerTransport {
  send(message: unknown): void
  on(event: "message", listener: (value: unknown) => void): this
  on(event: "error", listener: (error: Error) => void): this
  on(event: "exit", listener: (code: number) => void): this
  terminate(): Promise<number>
}

export interface HistoryPersistenceRuntime {
  start(config: HistoryWorkerStartConfig): Promise<HistoryWorkerReady>
  enqueue(envelope: HistoryOperationEnvelope, onOutcome: (outcome: HistoryPersistenceOutcome) => void): HistoryMessageId
  updateConfig(revision: number, config: HistoryWorkerHotConfig): Promise<RawTargetDescriptor>
  stopMaintenance(): Promise<void>
  drain(): Promise<HistoryDrainResult>
  shutdown(): Promise<void>
  snapshot(): HistoryWorkerStatus
  subscribe(listener: (status: HistoryWorkerStatus) => void): () => void
}

interface RuntimeOptions {
  readonly workerUrl?: URL
  readonly workerFactory?: (generation: WorkerGeneration) => HistoryWorkerTransport
  readonly tombstoneCapacity?: number
}

interface PendingEnvelope {
  readonly envelope: HistoryOperationEnvelope
  readonly onOutcome: (outcome: HistoryPersistenceOutcome) => void
}

interface CompletedAck {
  readonly messageId: HistoryMessageId
  readonly outcome: HistoryPersistenceOutcome
}

interface PendingRequest {
  readonly kind: "start" | "update-config" | "stop-maintenance" | "drain" | "shutdown"
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

export class HistoryPersistenceRuntimeImpl implements HistoryPersistenceRuntime {
  private readonly options: RuntimeOptions
  private readonly listeners = new Set<(status: HistoryWorkerStatus) => void>()
  private readonly pendingEnvelopes = new Map<HistoryMessageId, PendingEnvelope>()
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly completedAcks = new Map<HistoryMessageId, HistoryPersistenceOutcome>()
  private readonly completedAckOrder: Array<CompletedAck> = []
  private readonly outcomes = new Map<HistoryMessageId, HistoryPersistenceOutcome>()

  private transport: HistoryWorkerTransport | undefined
  private generation = 0
  private nextMessageId = 1
  private nextRequestId = 1
  private status: HistoryWorkerStatus = emptyStatus(0)

  constructor(options: RuntimeOptions = {}) {
    this.options = options
  }

  start(config: HistoryWorkerStartConfig): Promise<HistoryWorkerReady> {
    if (this.transport) return Promise.reject(new Error("History Worker runtime is already started"))
    this.generation++
    this.status = { ...emptyStatus(this.generation), latestDesiredRevision: config.configRevision }
    const transport = this.createTransport(this.generation)
    this.transport = transport
    transport.on("message", (value) => this.handleMessage(value))
    transport.on("error", (error) => this.failTerminal(error))
    transport.on("exit", (code) => {
      if (this.transport === transport) this.failTerminal(new Error(`History Worker exited unexpectedly with code ${code}`))
    })

    const requestId = this.nextRequestId++
    const promise = this.request<HistoryWorkerReady>(requestId, "start")
    this.send({
      type: "initialize",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: this.generation,
      requestId,
      config,
    })
    return promise
  }

  enqueue(envelope: HistoryOperationEnvelope, onOutcome: (outcome: HistoryPersistenceOutcome) => void): HistoryMessageId {
    const messageId = this.nextMessageId++
    if (this.status.terminalFailed || !this.transport) {
      this.outcomes.set(messageId, "failed")
      this.addTombstone(messageId, "failed")
      this.invokeOutcomeCallback({ envelope, onOutcome }, "failed")
      this.publishStatus()
      return messageId
    }
    this.pendingEnvelopes.set(messageId, { envelope, onOutcome })
    this.updatePendingStatus()
    this.publishStatus()
    this.send({
      type: "persist-operation",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: this.generation,
      messageId,
      envelope,
    })
    return messageId
  }

  updateConfig(revision: number, config: HistoryWorkerHotConfig): Promise<RawTargetDescriptor> {
    const requestId = this.nextRequestId++
    const promise = this.request<RawTargetDescriptor>(requestId, "update-config")
    this.status = { ...this.status, latestDesiredRevision: Math.max(this.status.latestDesiredRevision, revision) }
    this.publishStatus()
    this.send({
      type: "update-config",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: this.generation,
      requestId,
      revision,
      config,
    })
    return promise
  }

  stopMaintenance(): Promise<void> {
    return this.simpleRequest("stop-maintenance")
  }

  drain(): Promise<HistoryDrainResult> {
    const requestId = this.nextRequestId++
    const promise = this.request<HistoryDrainResult>(requestId, "drain")
    this.send({ type: "drain", protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION, workerGeneration: this.generation, requestId })
    return promise
  }

  async shutdown(): Promise<void> {
    if (!this.transport) return
    if (!this.status.terminalFailed) await this.simpleRequest("shutdown")
    await this.terminateTransport()
  }

  snapshot(): HistoryWorkerStatus {
    return this.status
  }

  subscribe(listener: (status: HistoryWorkerStatus) => void): () => void {
    this.listeners.add(listener)
    this.notifyStatusListener(listener)
    return () => this.listeners.delete(listener)
  }

  private simpleRequest(kind: "stop-maintenance" | "shutdown"): Promise<undefined> {
    const requestId = this.nextRequestId++
    const promise = this.request<undefined>(requestId, kind)
    this.send({ type: kind, protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION, workerGeneration: this.generation, requestId })
    return promise
  }

  private request<T>(requestId: number, kind: PendingRequest["kind"]): Promise<T> {
    if (this.status.terminalFailed) return Promise.reject(new Error(this.status.lastError ?? "History Worker runtime is terminal-failed"))
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(requestId, { kind, resolve: resolve as (value: unknown) => void, reject })
    })
  }

  private createTransport(generation: WorkerGeneration): HistoryWorkerTransport {
    if (this.options.workerFactory) return this.options.workerFactory(generation)
    const workerUrl = this.options.workerUrl ?? new URL("./history-worker.mjs", import.meta.url)
    return new NodeHistoryWorkerTransport(new Worker(workerUrl))
  }

  private send(message: MainToHistoryWorkerMessage): void {
    try {
      const parsed = parseMainToWorkerMessage(message)
      assertStructuredCloneSafe(parsed, `History Worker message ${parsed.type}`)
      if (!this.transport) throw new Error("History Worker runtime is not started")
      this.transport.send(parsed)
    } catch (error) {
      this.failTerminal(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handleMessage(value: unknown): void {
    let message: HistoryWorkerToMainMessage
    try {
      message = parseWorkerToMainMessage(value)
    } catch (error) {
      this.failTerminal(error instanceof Error ? error : new HistoryWorkerProtocolError("invalid History Worker response"))
      return
    }
    if (message.workerGeneration !== this.generation) {
      this.status = { ...this.status, staleMessagesTotal: this.status.staleMessagesTotal + 1 }
      this.publishStatus()
      return
    }

    switch (message.type) {
      case "ready": {
        this.status = {
          ...this.status,
          ready: true,
          threadId: message.ready.threadId,
          selectedDriver: message.ready.selectedDriver,
          publishedRevision: message.ready.configRevision,
        }
        this.resolveRequest(message.requestId, "start", message.ready)
        this.publishStatus()
        break
      }
      case "config-applied": {
        this.status = { ...this.status, publishedRevision: Math.max(this.status.publishedRevision, message.revision) }
        this.resolveRequest(message.requestId, "update-config", message.rawTarget)
        this.publishStatus()
        break
      }
      case "persist-result": {
        this.handlePersistResult(message.messageId, message.outcome)
        break
      }
      case "status": {
        this.status = { ...this.status, ...message.status, workerGeneration: this.generation }
        this.publishStatus()
        break
      }
      case "maintenance-stopped": {
        this.resolveRequest(message.requestId, "stop-maintenance", undefined)
        break
      }
      case "drained": {
        this.resolveRequest(message.requestId, "drain", message.result)
        break
      }
      case "closed": {
        this.resolveRequest(message.requestId, "shutdown", undefined)
        this.status = { ...this.status, ready: false }
        this.publishStatus()
        break
      }
      case "fatal": {
        this.failTerminal(new Error(message.error))
        break
      }
      default: {
        message satisfies never
      }
    }
  }

  private handlePersistResult(messageId: HistoryMessageId, outcome: HistoryPersistenceOutcome): void {
    const pending = this.pendingEnvelopes.get(messageId)
    if (!pending) {
      const completed = this.completedAcks.get(messageId)
      if (completed === outcome) {
        this.status = { ...this.status, duplicateAcksTotal: this.status.duplicateAcksTotal + 1 }
        this.publishStatus()
        return
      }
      if (completed !== undefined) {
        this.failTerminal(new HistoryWorkerProtocolError(`message ${messageId} changed outcome from ${completed} to ${outcome}`))
        return
      }
      this.failTerminal(new HistoryWorkerProtocolError(`ACK for unknown History message ${messageId}`))
      return
    }
    this.pendingEnvelopes.delete(messageId)
    this.outcomes.set(messageId, outcome)
    this.addTombstone(messageId, outcome)
    this.updatePendingStatus()
    this.invokeOutcomeCallback(pending, outcome)
    this.publishStatus()
  }

  private addTombstone(messageId: HistoryMessageId, outcome: HistoryPersistenceOutcome): void {
    this.completedAcks.set(messageId, outcome)
    this.completedAckOrder.push({ messageId, outcome })
    const capacity = this.options.tombstoneCapacity ?? DEFAULT_TOMBSTONE_CAPACITY
    while (this.completedAckOrder.length > capacity) {
      const oldest = this.completedAckOrder.shift()
      if (oldest && this.completedAcks.get(oldest.messageId) === oldest.outcome) this.completedAcks.delete(oldest.messageId)
    }
  }

  private resolveRequest(requestId: number, expected: PendingRequest["kind"], value: unknown): void {
    const request = this.pendingRequests.get(requestId)
    if (!request || request.kind !== expected) {
      this.failTerminal(new HistoryWorkerProtocolError(`unexpected ${expected} response for request ${requestId}`))
      return
    }
    this.pendingRequests.delete(requestId)
    request.resolve(value)
  }

  private failTerminal(error: Error): void {
    if (this.status.terminalFailed) return
    this.status = { ...this.status, ready: false, terminalFailed: true, lastError: error.message }
    const pendingEnvelopes = [...this.pendingEnvelopes.entries()]
    this.pendingEnvelopes.clear()
    for (const [messageId] of pendingEnvelopes) {
      this.outcomes.set(messageId, "failed")
      this.addTombstone(messageId, "failed")
    }
    const pendingRequests = [...this.pendingRequests.values()]
    this.pendingRequests.clear()
    this.updatePendingStatus()
    for (const [, pending] of pendingEnvelopes) this.invokeOutcomeCallback(pending, "failed")
    for (const request of pendingRequests) request.reject(error)
    this.publishStatus()
  }

  private invokeOutcomeCallback(pending: PendingEnvelope, outcome: HistoryPersistenceOutcome): void {
    try {
      pending.onOutcome(outcome)
    } catch (error) {
      this.status = {
        ...this.status,
        outcomeCallbackErrorsTotal: this.status.outcomeCallbackErrorsTotal + 1,
        lastOutcomeCallbackError: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private updatePendingStatus(): void {
    let pendingBytes = 0
    for (const pending of this.pendingEnvelopes.values()) pendingBytes += estimateEnvelopeBytes(pending.envelope)
    this.status = { ...this.status, pendingEnvelopes: this.pendingEnvelopes.size, pendingBytes }
  }

  private publishStatus(): void {
    for (const listener of this.listeners) this.notifyStatusListener(listener)
  }

  private notifyStatusListener(listener: (status: HistoryWorkerStatus) => void): void {
    try {
      listener(this.status)
    } catch (error) {
      this.status = {
        ...this.status,
        statusObserverErrorsTotal: this.status.statusObserverErrorsTotal + 1,
        lastStatusObserverError: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async terminateTransport(): Promise<void> {
    const transport = this.transport
    this.transport = undefined
    if (transport) await transport.terminate()
  }
}

export function createInProcessHistoryPersistenceRuntime(): HistoryPersistenceRuntimeImpl {
  return new HistoryPersistenceRuntimeImpl({ workerFactory: (generation) => new InProcessHistoryWorkerTransport(generation) })
}

class NodeHistoryWorkerTransport implements HistoryWorkerTransport {
  private readonly worker: Worker

  constructor(worker: Worker) {
    this.worker = worker
  }

  send(message: unknown): void {
    // Node Worker has no browser targetOrigin parameter; keep the lint exception at this adapter boundary.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    this.worker.postMessage(message)
  }

  on(event: "message", listener: (value: unknown) => void): this
  on(event: "error", listener: (error: Error) => void): this
  on(event: "exit", listener: (code: number) => void): this
  on(event: "message" | "error" | "exit", listener: ((value: unknown) => void) | ((error: Error) => void) | ((code: number) => void)): this {
    this.worker.on(event, listener as never)
    return this
  }

  terminate(): Promise<number> {
    return this.worker.terminate()
  }
}

class InProcessHistoryWorkerTransport implements HistoryWorkerTransport {
  private readonly generation: WorkerGeneration
  private readonly listeners = {
    message: new Set<(value: unknown) => void>(),
    error: new Set<(error: Error) => void>(),
    exit: new Set<(code: number) => void>(),
  }
  private outcomes: Record<number, HistoryPersistenceOutcome> = {}

  constructor(generation: WorkerGeneration) {
    this.generation = generation
  }

  send(value: unknown): void {
    const message = structuredClone(parseMainToWorkerMessage(value))
    queueMicrotask(() => {
      switch (message.type) {
        case "initialize": {
          this.emit({
            type: "ready",
            protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
            workerGeneration: this.generation,
            requestId: message.requestId,
            ready: {
              workerGeneration: this.generation,
              threadId: 1,
              selectedDriver: detectHistorySqliteDriver(),
              configRevision: message.config.configRevision,
              rawTarget: createRawTargetDescriptor(message.config.configRevision, message.config.rawConfig),
            },
          })
          break
        }
        case "persist-operation": {
          this.outcomes[message.messageId] = "failed"
          this.emit({
            type: "persist-result",
            protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
            workerGeneration: this.generation,
            messageId: message.messageId,
            outcome: "failed",
          })
          break
        }
        case "update-config": {
          this.emit({
            type: "config-applied",
            protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
            workerGeneration: this.generation,
            requestId: message.requestId,
            revision: message.revision,
            rawTarget: createRawTargetDescriptor(message.revision, message.config.rawConfig),
          })
          break
        }
        case "stop-maintenance": {
          this.emit({
            type: "maintenance-stopped",
            protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
            workerGeneration: this.generation,
            requestId: message.requestId,
          })
          break
        }
        case "drain": {
          this.emit({
            type: "drained",
            protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
            workerGeneration: this.generation,
            requestId: message.requestId,
            result: { outcomes: this.outcomes },
          })
          break
        }
        case "shutdown": {
          this.emit({
            type: "closed",
            protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
            workerGeneration: this.generation,
            requestId: message.requestId,
          })
          break
        }
        default: {
          message satisfies never
        }
      }
    })
  }

  on(event: "message", listener: (value: unknown) => void): this
  on(event: "error", listener: (error: Error) => void): this
  on(event: "exit", listener: (code: number) => void): this
  on(event: "message" | "error" | "exit", listener: ((value: unknown) => void) | ((error: Error) => void) | ((code: number) => void)): this {
    ;(this.listeners[event] as Set<typeof listener>).add(listener)
    return this
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }

  private emit(value: unknown): void {
    const cloned = structuredClone(value)
    for (const listener of this.listeners.message) listener(cloned)
  }
}

function emptyStatus(workerGeneration: WorkerGeneration): HistoryWorkerStatus {
  return {
    workerGeneration,
    ready: false,
    terminalFailed: false,
    pendingEnvelopes: 0,
    pendingBytes: 0,
    latestDesiredRevision: 0,
    publishedRevision: 0,
    restartsTotal: 0,
    replaysTotal: 0,
    staleMessagesTotal: 0,
    duplicateAcksTotal: 0,
    outcomeCallbackErrorsTotal: 0,
    statusObserverErrorsTotal: 0,
  }
}

function estimateEnvelopeBytes(envelope: HistoryOperationEnvelope): number {
  let bytes = 0
  for (const command of envelope.publication.rawAttachment.rawCommands) bytes += command.bytes.byteLength
  return bytes
}
