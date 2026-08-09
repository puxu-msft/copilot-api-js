import { Worker } from "node:worker_threads"

import type { HistoryTerminalSink } from "./admission"
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
import type { HistoryWorkerRestartPolicyOptions } from "./restart-policy"

import {
  //
  HISTORY_WORKER_PROTOCOL_VERSION,
  HistoryWorkerProtocolError,
  assertStructuredCloneSafe,
  estimateHistoryEnvelopeBytes,
  parseMainToWorkerMessage,
  parseWorkerToMainMessage,
} from "./protocol"
import { HistoryWorkerRestartPolicy } from "./restart-policy"

const DEFAULT_TOMBSTONE_CAPACITY = 256

export interface HistoryWorkerTransport {
  send(message: unknown): void
  on(event: "message", listener: (value: unknown) => void): this
  on(event: "error", listener: (error: Error) => void): this
  on(event: "exit", listener: (code: number) => void): this
  terminate(): Promise<number>
}

export interface HistoryPersistenceRuntime extends HistoryTerminalSink {
  start(config: HistoryWorkerStartConfig): Promise<HistoryWorkerReady>
  updateConfig(revision: number, config: HistoryWorkerHotConfig): Promise<RawTargetDescriptor>
  stopMaintenance(): Promise<void>
  drain(): Promise<HistoryDrainResult>
  shutdown(): Promise<void>
  snapshot(): HistoryWorkerStatus
  subscribe(listener: (status: HistoryWorkerStatus) => void): () => void
}

interface RuntimeOptions {
  readonly workerUrl?: URL
  readonly workerData?: unknown
  readonly workerFactory?: (generation: WorkerGeneration) => HistoryWorkerTransport
  readonly tombstoneCapacity?: number
  readonly restart?: HistoryWorkerRestartPolicyOptions & {
    /** Timer seam; returns a cancel function. Tests drive restarts without real time. */
    readonly setTimer?: (fn: () => void, ms: number) => () => void
  }
}

interface PendingEnvelope {
  readonly envelope: HistoryOperationEnvelope
  readonly onOutcome: (outcome: HistoryPersistenceOutcome) => void
  /** Generation this envelope was last handed to; `undefined` means never sent. */
  sentGeneration?: WorkerGeneration
}

interface CompletedAck {
  readonly messageId: HistoryMessageId
  readonly outcome: HistoryPersistenceOutcome
  /** Generation that settled it: a later generation ACKing the same id never received it. */
  readonly generation: WorkerGeneration
}

interface PendingRequest {
  readonly kind: "start" | "update-config" | "stop-maintenance" | "drain" | "shutdown"
  readonly expectedRevision?: number
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  /** Rebuilds this request for a fresh Worker generation after a crash. */
  readonly reissue: (requestId: number, generation: WorkerGeneration) => MainToHistoryWorkerMessage
}

export class HistoryPersistenceRuntimeImpl implements HistoryPersistenceRuntime {
  private readonly options: RuntimeOptions
  private readonly listeners = new Set<(status: HistoryWorkerStatus) => void>()
  private readonly pendingEnvelopes = new Map<HistoryMessageId, PendingEnvelope>()
  private readonly pendingRequests = new Map<number, PendingRequest>()
  private readonly completedAcks = new Map<HistoryMessageId, CompletedAck>()
  private readonly completedAckOrder: Array<CompletedAck> = []
  private readonly outcomes = new Map<HistoryMessageId, HistoryPersistenceOutcome>()
  /** Requests a crashed generation was holding; re-issued once the replacement is ready. */
  private readonly requestsAwaitingReissue: Array<PendingRequest> = []

  private transport: HistoryWorkerTransport | undefined
  private generation = 0
  private nextMessageId = 1
  private nextRequestId = 1
  private status: HistoryWorkerStatus = emptyStatus(0)
  private startConfig: HistoryWorkerStartConfig | undefined
  /** Hot config belonging to `status.latestDesiredRevision`; a restart must initialize with THIS, not the start config. */
  private latestDesiredConfig: HistoryWorkerHotConfig | undefined
  private readonly restartPolicy: HistoryWorkerRestartPolicy
  /** The current generation has crashed and has not been replaced yet: nothing it says may be believed. */
  private generationRetired = false
  /** Worker termination started by `failTerminal`; `shutdown()` awaits it for the §8.2 step 7 barrier. */
  private terminationInFlight: Promise<void> | undefined
  private cancelRestartTimer: (() => void) | undefined
  private stopped = false

  constructor(options: RuntimeOptions = {}) {
    this.options = options
    this.restartPolicy = new HistoryWorkerRestartPolicy(options.restart)
  }

  start(config: HistoryWorkerStartConfig): Promise<HistoryWorkerReady> {
    // Order matters: terminal and stopped are reported first because they are the more
    // fundamental (and more actionable) conditions — "already started" would be true of a
    // terminally-failed runtime too, and saying so would hide why it can never come back.
    if (this.status.terminalFailed) return Promise.reject(new Error(`History Worker runtime is terminally failed: ${this.status.lastError ?? "unknown"}`))
    if (this.stopped) return Promise.reject(new Error("History Worker runtime has been shut down"))
    // `startConfig` rather than `transport`: during a restart backoff there is no transport,
    // so the transport alone answers "is a Worker running" when the question is "has this
    // runtime already been started".
    if (this.startConfig) return Promise.reject(new Error("History Worker runtime is already started"))
    this.startConfig = config
    this.status = { ...emptyStatus(this.generation + 1), latestDesiredRevision: config.configRevision }
    return new Promise<HistoryWorkerReady>((resolve, reject) => {
      this.launchWorker({ resolve: resolve as (value: unknown) => void, reject })
    })
  }

  /**
   * Create a Worker generation and hand it an `initialize`.
   *
   * Both the first start and every restart come through here, so a replacement is
   * initialized from the frozen start config overlaid with the LATEST desired hot config
   * and its revision — a restart must not quietly re-derive either from live state, and
   * must not pair a new revision number with the config of an old one.
   */
  private launchWorker(startWaiter?: { resolve: (value: unknown) => void; reject: (error: Error) => void }): void {
    const config = this.startConfig
    if (!config) throw new Error("History Worker runtime cannot launch before start()")
    this.generation++
    this.generationRetired = false
    const generation = this.generation
    const transport = this.createTransport(generation)
    this.transport = transport
    transport.on("message", (value) => this.handleMessage(value))
    transport.on("error", (error) => this.handleTransportCrash(transport, error))
    transport.on("exit", (code) => this.handleTransportCrash(transport, new Error(`History Worker exited unexpectedly with code ${code}`)))

    // The revision and the hot config it labels MUST come from the same snapshot. Bumping
    // only `configRevision` would hand the replacement the ORIGINAL raw config under the
    // latest revision number, and its `ready` descriptor — which §5.3 publishes atomically
    // as the active target — would then describe an artifact nobody asked for.
    const initializeConfig: HistoryWorkerStartConfig = {
      ...config,
      ...this.latestDesiredConfig,
      configRevision: this.status.latestDesiredRevision,
    }
    const requestId = this.nextRequestId++
    this.pendingRequests.set(requestId, {
      kind: "start",
      expectedRevision: initializeConfig.configRevision,
      resolve: (value) => startWaiter?.resolve(value),
      reject: (error) => startWaiter?.reject(error),
      reissue: (nextRequestId, nextGeneration) => ({
        type: "initialize",
        protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
        workerGeneration: nextGeneration,
        requestId: nextRequestId,
        config: initializeConfig,
      }),
    })
    this.send({
      type: "initialize",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: generation,
      requestId,
      config: initializeConfig,
    })
  }

  enqueue(envelope: HistoryOperationEnvelope, onOutcome: (outcome: HistoryPersistenceOutcome) => void): HistoryMessageId {
    const messageId = this.nextMessageId++
    if (this.status.terminalFailed || !this.startConfig || this.stopped) {
      this.outcomes.set(messageId, "failed")
      this.addTombstone(messageId, "failed")
      this.invokeOutcomeCallback({ envelope, onOutcome }, "failed")
      this.publishStatus()
      return messageId
    }
    const pending: PendingEnvelope = { envelope, onOutcome }
    this.pendingEnvelopes.set(messageId, pending)
    this.updatePendingStatus()
    this.publishStatus()
    // While a generation is down (crashed, or not ready yet) the envelope stays queued and
    // is delivered by the ready-replay in message-ID order. `postMessage` is not durability
    // and admission stays open until capacity is reached, so holding is the correct state.
    if (this.transport && this.status.ready) this.sendEnvelope(messageId, pending)
    return messageId
  }

  updateConfig(revision: number, config: HistoryWorkerHotConfig): Promise<RawTargetDescriptor> {
    const requestId = this.nextRequestId++
    const promise = this.request<RawTargetDescriptor>(requestId, "update-config", revision, (nextRequestId, nextGeneration) => ({
      type: "update-config",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: nextGeneration,
      requestId: nextRequestId,
      revision,
      config,
    }))
    // Keep revision and config together: only a revision that actually advances the desired
    // state may replace the snapshot a restart will initialize from. A late-arriving lower
    // revision must not drag the target backwards (§5.3).
    if (revision >= this.status.latestDesiredRevision) this.latestDesiredConfig = config
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
    const promise = this.request<HistoryDrainResult>(requestId, "drain", undefined, (nextRequestId, nextGeneration) => ({
      type: "drain",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: nextGeneration,
      requestId: nextRequestId,
    }))
    this.send({ type: "drain", protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION, workerGeneration: this.generation, requestId })
    return promise
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.cancelRestartTimer?.()
    this.cancelRestartTimer = undefined
    if (!this.transport) {
      // Shutdown landed inside a restart backoff window, or after fatal already terminated
      // the generation. In the backoff case no Worker exists and, because `stopped` is now
      // set, none will be created — so the ACK that would settle these can never arrive and
      // `drain()` (§8.2 step 5) would wait forever. After fatal they are already settled, and
      // re-running this would only republish a status with a misleading error.
      if (!this.status.terminalFailed) {
        this.settleUnackedAsFailed(new Error("History Worker runtime shut down while no Worker generation was running"))
      }
      // §8.2 step 7 only passes once the Worker is actually closed. `failTerminal` starts the
      // termination without blocking its own synchronous transition, so this is where the
      // barrier waits for it.
      await this.terminationInFlight
      return
    }
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
    const promise = this.request<undefined>(requestId, kind, undefined, (nextRequestId, nextGeneration) => ({
      type: kind,
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: nextGeneration,
      requestId: nextRequestId,
    }))
    this.send({ type: kind, protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION, workerGeneration: this.generation, requestId })
    return promise
  }

  private request<T>(requestId: number, kind: PendingRequest["kind"], expectedRevision: number | undefined, reissue: PendingRequest["reissue"]): Promise<T> {
    if (this.status.terminalFailed) return Promise.reject(new Error(this.status.lastError ?? "History Worker runtime is terminal-failed"))
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(requestId, { kind, expectedRevision, resolve: resolve as (value: unknown) => void, reject, reissue })
    })
  }

  private createTransport(generation: WorkerGeneration): HistoryWorkerTransport {
    if (this.options.workerFactory) return this.options.workerFactory(generation)
    const workerUrl = this.options.workerUrl ?? new URL("./history-worker.mjs", import.meta.url)
    return new NodeHistoryWorkerTransport(new Worker(workerUrl, { workerData: this.options.workerData }))
  }

  private send(message: MainToHistoryWorkerMessage): void {
    try {
      const parsed = parseMainToWorkerMessage(message)
      assertStructuredCloneSafe(parsed, `History Worker message ${parsed.type}`)
      if (!this.transport) {
        // Between a crash and its replacement generation there is no transport. A started,
        // non-terminal runtime holds the message instead of failing: pending requests are
        // re-issued to the new generation on ready, which is what lets a `drain()` survive a
        // crash mid-drain (spec §8.2). Only a never-started or shut-down runtime is an error.
        if (this.startConfig && !this.stopped && !this.status.terminalFailed) return
        throw new Error("History Worker runtime is not started")
      }
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
    // A retired generation's word is not trusted for anything that would settle state — but
    // `fatal` is the exception, and deliberately so: it reports a PERMANENT condition (unowned
    // artifact, unrecoverable schema) that a replacement would only rediscover. Dropping it
    // would trade an immediate terminal transition for another doomed restart cycle.
    if (message.workerGeneration !== this.generation || (this.generationRetired && message.type !== "fatal")) {
      this.status = { ...this.status, staleMessagesTotal: this.status.staleMessagesTotal + 1 }
      this.publishStatus()
      return
    }

    switch (message.type) {
      case "ready": {
        const request = this.validateResponseRequest(message.requestId, "start", message.ready.configRevision)
        if (!request) break
        if (message.ready.configRevision !== this.status.latestDesiredRevision) {
          this.failTerminal(
            new HistoryWorkerProtocolError(
              `ready revision ${message.ready.configRevision} does not match latest desired revision ${this.status.latestDesiredRevision}`,
            ),
          )
          break
        }
        this.pendingRequests.delete(message.requestId)
        this.status = {
          ...this.status,
          ready: true,
          threadId: message.ready.threadId,
          selectedDriver: message.ready.selectedDriver,
          publishedRevision: message.ready.configRevision,
          recoveredJournalOperations: message.ready.recoveredJournalOperations,
          consecutiveFailures: 0,
          nextRetryAt: undefined,
        }
        this.restartPolicy.recordSuccess()
        request.resolve(message.ready)
        this.replayPendingEnvelopes()
        this.reissueOutstandingRequests()
        this.publishStatus()
        break
      }
      case "config-applied": {
        const request = this.validateResponseRequest(message.requestId, "update-config", message.revision)
        if (!request) break
        this.pendingRequests.delete(message.requestId)
        if (message.revision === this.status.latestDesiredRevision) {
          this.status = { ...this.status, publishedRevision: message.revision }
        }
        request.resolve(message.rawTarget)
        this.publishStatus()
        break
      }
      case "persist-result": {
        this.handlePersistResult(message.messageId, message.outcome)
        break
      }
      case "status": {
        if (this.status.terminalFailed) {
          this.status = { ...this.status, staleMessagesTotal: this.status.staleMessagesTotal + 1 }
          this.publishStatus()
          break
        }
        const revision = message.status.publishedRevision
        if (revision !== undefined && revision < this.status.publishedRevision) {
          this.failTerminal(new HistoryWorkerProtocolError(`Worker status publishedRevision ${revision} regresses from ${this.status.publishedRevision}`))
          break
        }
        if (revision !== undefined && revision > this.status.latestDesiredRevision) {
          this.failTerminal(
            new HistoryWorkerProtocolError(`Worker status publishedRevision ${revision} exceeds latest desired revision ${this.status.latestDesiredRevision}`),
          )
          break
        }
        this.status = { ...this.status, ...message.status }
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

  /**
   * THE single transition out of `unacked` (spec §7.2: "只有首次从 `unacked` 离开的路径能释放 reservation").
   *
   * Both the ACK path and fatal's bulk termination race for the same message, so neither may
   * delete-and-notify on its own: whichever arrives second must find the entry already gone
   * and do nothing. Returning a boolean rather than relying on the callers being careful is
   * what makes the exactly-once property structural instead of a coincidence of ordering.
   */
  private settleMessage(messageId: HistoryMessageId, outcome: HistoryPersistenceOutcome): boolean {
    const pending = this.pendingEnvelopes.get(messageId)
    if (!pending) return false
    this.pendingEnvelopes.delete(messageId)
    this.outcomes.set(messageId, outcome)
    this.addTombstone(messageId, outcome)
    // BEFORE the callback, not after. Batch 2b's admission releases its reservation inside
    // `onOutcome` and wakes the next FIFO waiter; if the counters still described the
    // pre-settlement state, that waiter would read a queue depth that has already changed.
    this.updatePendingStatus()
    this.invokeOutcomeCallback(pending, outcome)
    return true
  }

  private handlePersistResult(messageId: HistoryMessageId, outcome: HistoryPersistenceOutcome): void {
    if (this.settleMessage(messageId, outcome)) {
      this.publishStatus()
      return
    }
    const completed = this.completedAcks.get(messageId)
    if (completed === undefined) {
      this.failTerminal(new HistoryWorkerProtocolError(`ACK for unknown History message ${messageId}`))
      return
    }
    // A tombstone written by a DIFFERENT generation means the current one is ACKing a message
    // it never received: a replayed envelope is only re-sent while it is still unacked, and a
    // dead generation's late ACK is rejected upstream by the generation guard. Without the
    // generation on the tombstone this reads as a benign duplicate, and a Worker inventing
    // message IDs would run on undetected.
    if (completed.generation !== this.generation) {
      this.failTerminal(
        new HistoryWorkerProtocolError(
          `generation ${this.generation} ACKed message ${messageId}, which generation ${completed.generation} had already settled`,
        ),
      )
      return
    }
    if (completed.outcome !== outcome) {
      this.failTerminal(new HistoryWorkerProtocolError(`message ${messageId} changed outcome from ${completed.outcome} to ${outcome}`))
      return
    }
    // Same outcome, already settled: an at-least-once transport may deliver an ACK twice.
    this.status = { ...this.status, duplicateAcksTotal: this.status.duplicateAcksTotal + 1 }
    this.publishStatus()
  }

  /** Hand one queued envelope to the current generation and remember which one got it. */
  private sendEnvelope(messageId: HistoryMessageId, pending: PendingEnvelope): void {
    pending.sentGeneration = this.generation
    this.send({
      type: "persist-operation",
      protocolVersion: HISTORY_WORKER_PROTOCOL_VERSION,
      workerGeneration: this.generation,
      messageId,
      envelope: pending.envelope,
    })
  }

  /**
   * Re-deliver every un-ACKed envelope to a freshly ready generation, in message-ID order.
   *
   * Ordering is part of the contract: replay must reproduce the original submission order,
   * and semantic idempotency (`operation_id + revision + digest`) makes a re-delivered
   * envelope a no-op rather than a duplicate row. Only envelopes that a PREVIOUS generation
   * already saw count as replays — an envelope queued while the Worker was down is being
   * sent for the first time, and reporting it as a replay would inflate the metric operators
   * use to spot a crash-looping Worker.
   */
  private replayPendingEnvelopes(): void {
    const ordered = [...this.pendingEnvelopes.entries()].sort(([left], [right]) => left - right)
    let replays = 0
    for (const [messageId, pending] of ordered) {
      if (pending.sentGeneration !== undefined && pending.sentGeneration !== this.generation) replays++
      if (pending.sentGeneration !== this.generation) this.sendEnvelope(messageId, pending)
    }
    if (replays > 0) this.status = { ...this.status, replaysTotal: this.status.replaysTotal + replays }
  }

  /**
   * A Worker died without saying `fatal`: recoverable by construction.
   *
   * Un-ACKed envelopes and their reservations are deliberately retained — `postMessage`
   * was never durability, so releasing them here would silently drop History records
   * (spec §13.5). Outstanding requests are re-issued against the new generation, because
   * their request IDs belonged to the dead one.
   */
  private handleTransportCrash(transport: HistoryWorkerTransport, error: Error): void {
    if (this.transport !== transport || this.status.terminalFailed || this.stopped) return
    this.transport = undefined
    // Retire the generation AT THE CRASH, not when the replacement launches. Between those
    // two moments `this.generation` still names the dead thread, so a message it emitted on
    // its way out would pass the generation guard and be believed — settling an envelope
    // (and dropping it from the replay set) on the word of a generation we have written off.
    this.generationRetired = true
    const decision = this.restartPolicy.recordFailure()
    this.status = {
      ...this.status,
      ready: false,
      restartsTotal: this.status.restartsTotal + 1,
      consecutiveFailures: decision.consecutiveFailures,
      nextRetryAt: decision.nextRetryAt,
      lastError: error.message,
    }
    this.publishStatus()

    const setTimer = this.options.restart?.setTimer ?? defaultRestartTimer
    this.cancelRestartTimer = setTimer(() => {
      this.cancelRestartTimer = undefined
      if (this.stopped || this.status.terminalFailed) return
      // The dead generation owned these request IDs. The start waiter (if any) rides the new
      // `initialize`; every other outstanding request is re-issued only once the replacement
      // is ready — see `reissueOutstandingRequests` for why it cannot be sent here.
      const outstanding = [...this.pendingRequests.values()]
      this.pendingRequests.clear()
      const startWaiter = outstanding.find((request) => request.kind === "start")
      this.requestsAwaitingReissue.push(...outstanding.filter((request) => request.kind !== "start"))
      this.launchWorker(startWaiter ? { resolve: startWaiter.resolve, reject: startWaiter.reject } : undefined)
    }, decision.delayMs)
  }

  /**
   * Re-send the requests a dead generation was holding, AFTER the envelope replay.
   *
   * Order is the whole point: the Worker serializes what it receives, so a `drain` re-issued
   * before the replayed envelopes would report "everything received so far is settled" while
   * those envelopes were still in the main thread's queue — a drain barrier that lies is
   * exactly what shutdown must never get (spec §8.2).
   */
  private reissueOutstandingRequests(): void {
    const outstanding = this.requestsAwaitingReissue.splice(0)
    for (const request of outstanding) {
      const requestId = this.nextRequestId++
      this.pendingRequests.set(requestId, request)
      this.send(request.reissue(requestId, this.generation))
    }
  }

  private addTombstone(messageId: HistoryMessageId, outcome: HistoryPersistenceOutcome): void {
    const tombstone: CompletedAck = { messageId, outcome, generation: this.generation }
    this.completedAcks.set(messageId, tombstone)
    this.completedAckOrder.push(tombstone)
    const capacity = this.options.tombstoneCapacity ?? DEFAULT_TOMBSTONE_CAPACITY
    while (this.completedAckOrder.length > capacity) {
      const oldest = this.completedAckOrder.shift()
      if (oldest && this.completedAcks.get(oldest.messageId) === oldest) this.completedAcks.delete(oldest.messageId)
    }
  }

  private validateResponseRequest(requestId: number, expected: PendingRequest["kind"], revision: number): PendingRequest | undefined {
    const request = this.pendingRequests.get(requestId)
    if (!request || request.kind !== expected) {
      this.failTerminal(new HistoryWorkerProtocolError(`unexpected ${expected} response for request ${requestId}`))
      return undefined
    }
    if (request.expectedRevision !== revision) {
      this.failTerminal(
        new HistoryWorkerProtocolError(
          `${expected === "start" ? "ready" : "config-applied"} revision ${revision} does not match expected revision ${String(request.expectedRevision)}`,
        ),
      )
      return undefined
    }
    return request
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
    // Terminal means terminal: no further Worker may be created, so a scheduled restart
    // is cancelled before anything else observes the new state (spec §7.2 step 1).
    this.cancelRestartTimer?.()
    this.cancelRestartTimer = undefined
    this.status = { ...this.status, ready: false, terminalFailed: true, nextRetryAt: undefined, lastError: error.message }
    // Publish BEFORE settling anything (spec §7.2: close admission at step 2, terminate the
    // un-ACKed set at step 3). Settling releases reservations, and a release wakes the FIFO
    // waiter — so a subscriber that has not yet closed admission would hand a fresh
    // reservation to a request whose History record can never be written.
    this.publishStatus()
    this.settleUnackedAsFailed(error)
    // Terminal means no Worker may ever run again, so the dead generation must not outlive
    // the decision. Leaving it alive keeps a Worker thread — and therefore the process —
    // running with nobody reading its port, which would stall the graceful shutdown §7.2
    // step 5 hands off to. `terminate()` re-fires `exit`, which `handleTransportCrash`
    // already ignores once `terminalFailed` is set.
    // Kept as a field so `shutdown()` can await it: §8.2 step 7 does not pass until the
    // Worker is really closed, but `failTerminal` itself must stay synchronous so the
    // terminal state is visible before anything else observes it.
    this.terminationInFlight = this.terminateTransport().catch((terminateError: unknown) => {
      this.status = { ...this.status, lastError: `${error.message}; terminate failed: ${String(terminateError)}` }
      this.publishStatus()
    })
  }

  /**
   * Give every un-ACKed envelope a terminal `failed` outcome and reject every waiting request.
   *
   * Used by both irreversible fatal (§7.2 step 3) and shutdown-with-no-Worker (§8.2): in both
   * cases the ACK that would settle these items can never arrive, and a reservation that is
   * never released is indistinguishable from a hang.
   */
  private settleUnackedAsFailed(error: Error): void {
    // Goes through the SAME `settleMessage` primitive as the ACK path, so a message that has
    // already left `unacked` cannot be released a second time here (spec §7.2).
    // Snapshot the keys first: `settleMessage` deletes from this very map. Mutating a Map
    // mid-iteration is legal but subtle, and the rule below cannot see the mutation.
    // eslint-disable-next-line unicorn/no-useless-spread
    for (const messageId of [...this.pendingEnvelopes.keys()]) this.settleMessage(messageId, "failed")
    // Requests parked for re-issue belong to a generation that will never be replaced now,
    // so they are rejected with the same error rather than waiting for a Worker that is
    // never coming.
    const pendingRequests = [...this.pendingRequests.values(), ...this.requestsAwaitingReissue.splice(0)]
    this.pendingRequests.clear()
    this.updatePendingStatus()
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
    for (const pending of this.pendingEnvelopes.values()) pendingBytes += estimateHistoryEnvelopeBytes(pending.envelope)
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
    recoveredJournalOperations: 0,
    consecutiveFailures: 0,
    staleMessagesTotal: 0,
    duplicateAcksTotal: 0,
    outcomeCallbackErrorsTotal: 0,
    statusObserverErrorsTotal: 0,
  }
}

/** Real-timer restart seam. Not unref'd: a pending History restart is work the process owes. */
function defaultRestartTimer(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms)
  return () => clearTimeout(handle)
}
