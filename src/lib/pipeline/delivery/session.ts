/**
 * Generation-owned downstream delivery session.
 *
 * This first cut centralizes the unique wire serializer and derives block state only from writes that
 * actually reach the injected ClientSink. It deliberately has no upstream attempt/candidate dependency;
 * round notifications are diagnostic no-ops for wire state. Heartbeat and terminal fencing build on this
 * owner in the next task.
 */

import consola from "consola"

import type { PipelineInfo } from "~/lib/history"

import { readSyntheticKind } from "~/lib/pipeline/frame-origin"
import { classifyStreamError } from "~/lib/stream"

import type {
  //
  ClientFrame,
  ClientSink,
  GenerationWireState,
  LegSource,
  LegToken,
  OwnerOperation,
  WireBlockMapping,
  WireIndexReservation,
} from "../types"
import type {
  //
  ClientBlockLedger,
  DeliveredOpenBlock,
  DeliveryFrame,
  DeliveryHeartbeat,
  DeliverySnapshot,
  OwnerRawSink,
  DeliverySyntheticKind,
  DeliveryTerminalCommand,
  OwnerResult,
  WireBlockAllocationPort,
  WireEnvelopeFactory,
  WireWriteSpec,
} from "./types"

import { createDeliverySerializer } from "./serializer"

/** Construction options for one generation delivery. */
export interface CreateDownstreamDeliverySessionOptions {
  readonly sink: OwnerRawSink
  readonly monotonicNow?: () => number
  readonly heartbeat?: DeliveryHeartbeat
  readonly wireState?: GenerationWireState
  /** Migration-only close-side mirror; removed with AnchorState legacy fields at M5. */
  readonly legacyAnchorMirror?: { anchorClosed: boolean }
  readonly recordWirePartialDelivery?: (diag: NonNullable<PipelineInfo["wirePartialDelivery"]>) => void
  /** Client-format semantic-content predicate, evaluated only after a successful candidate wire write. */
  readonly isRealContentFrame?: (frame: ClientFrame) => boolean
}

export interface DeliverySessionTestHooks {
  onWrite?: (entry: DeliveryFrame) => void | Promise<void>
  /** Runs inside the owner before a leg is created; a throw leaves the session reusable. */
  onBeginLeg?: (kind: "primary" | "continuation" | "recovery") => void | Promise<void>
  /** Runs after C9 reservation commit, inside the allocation try/catch. */
  onCommittedAllocation?: (operation: "allocate-anchor" | "allocate-real-block") => void | Promise<void>
  /** Runs after recovery-batch staging and before its C9 commit; a throw leaves the session reusable. */
  onBeforeRecoveryBatchCommit?: () => void | Promise<void>
  /** Runs inside the owner immediately before a terminal anchor close wire write. */
  onCloseAnchor?: () => void | Promise<void>
  /** Observes the actual driver terminal outcome on the production handler path. */
  onResponseOutcome?: (outcome: { kind: "stream-error"; source: import("../types").ResponseFailureSource }) => void
}

/** Generation-scoped delivery port consumed by the retry/competition engine. */
export interface DownstreamDeliverySession {
  readonly identity: symbol
  /** Irreversible, delivery-scoped flag for real client content that completed a successful owner write. */
  readonly hasEmittedRealClientContent: boolean
  readonly snapshot: DeliverySnapshot
  readonly clientSink: ClientSink
  readonly allocationPort: WireBlockAllocationPort
  writeScaffold(frames: ReadonlyArray<DeliveryFrame>): Promise<void>
  noteWinner(source: LegSource): void
  noteUpstreamRoundEnded(reason: string): void
  noteUpstreamRoundStarted(candidateId: string): void
  terminate(command: DeliveryTerminalCommand): Promise<void>
}

const deliveryBySink = new WeakMap<ClientSink, DownstreamDeliverySession>()
const deliveryByAllocationPort = new WeakMap<WireBlockAllocationPort, DownstreamDeliverySession>()
let deliverySessionObserverForTests: ((session: DownstreamDeliverySession) => void) | undefined
let deliverySessionTestHooks: DeliverySessionTestHooks | undefined

/** Test-only observer for HTTP-path wiring assertions; reset through isolated-fixture RESETTERS. */
export function setDeliverySessionObserverForTests(observer: ((session: DownstreamDeliverySession) => void) | undefined): void {
  deliverySessionObserverForTests = observer
}

/** Test-only production-path fault injection; hooks run inside the real delivery session. */
export function setDeliverySessionTestHooksForTests(hooks: DeliverySessionTestHooks | undefined): void {
  deliverySessionTestHooks = hooks
}

/** Test-only outcome observer; called only from the driver's typed failure funnel. */
export function recordDeliveryResponseOutcomeForTests(outcome: { kind: "stream-error"; source: import("../types").ResponseFailureSource }): void {
  deliverySessionTestHooks?.onResponseOutcome?.(outcome)
}

/** A non-client owner failure, tagged at the source with whether C9's commit point was crossed. */
export class DeliveryOwnerError extends Error {
  readonly committed: boolean

  constructor(cause: unknown, committed: boolean) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "DeliveryOwnerError"
    this.committed = committed
  }
}

/** Resolve the generation-owned delivery behind a production delivery sink. */
export function getDownstreamDeliverySession(sink: ClientSink): DownstreamDeliverySession | undefined {
  return deliveryBySink.get(sink)
}

/** Resolve the same owner from an explicitly passed allocation port without registering wrapper sinks. */
export function getDeliverySessionForAllocationPort(port: WireBlockAllocationPort): DownstreamDeliverySession | undefined {
  return deliveryByAllocationPort.get(port)
}

/** Create a delivery session whose identity and ledger outlive every upstream round. */
export function createDownstreamDeliverySession(options: CreateDownstreamDeliverySessionOptions): DownstreamDeliverySession {
  const { sink } = options
  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance)
  const heartbeat = options.heartbeat
  const isRealContentFrame = options.isRealContentFrame
  const serializer = createDeliverySerializer()
  const identity = Symbol("downstreamDeliverySession")
  let state: DeliverySnapshot["state"] = "open"
  let finishReason: "client-gone" | "session-terminating" | undefined
  let wireTorn = false
  let winnerCandidateId: string | undefined
  let winnerSource: LegSource | undefined
  let messageEnvelope: ClientBlockLedger["messageEnvelope"] = "none"
  let openBlocks: Array<DeliveredOpenBlock> = []
  let lastWriteAtMonotonic = 0
  let lastContentDeltaAtMonotonic = monotonicNow()
  let semanticBlockCount = 0
  let terminalWritten = false
  let writeCount = 0
  const upstreamRounds: Array<string> = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let heartbeatSuspended = false
  let heartbeatStopped = false
  let scaffoldAttempted = false
  let contentScaffoldAttempted = false
  let pendingOpenBlocks: Array<DeliveredOpenBlock> = []
  let hasEmittedRealClientContent = false
  let finalized: Promise<void> | undefined

  const write = async (entry: DeliveryFrame, allowTerminating = false): Promise<void> => {
    await serializer.enqueue(async () => {
      if (state !== "open" && (!allowTerminating || state !== "terminating")) return
      applyPendingFrame(entry)
      const onWriteForTests = deliverySessionTestHooks?.onWrite
      if (onWriteForTests) await onWriteForTests(entry)
      await writeToSink(sink, entry)
      applyWireFrame(entry)
      const writtenAt = monotonicNow()
      lastWriteAtMonotonic = writtenAt
      if (isContentDelta(entry.frame)) lastContentDeltaAtMonotonic = writtenAt
      writeCount++
    })
  }

  const currentLedger = (): ClientBlockLedger =>
    Object.freeze({
      messageEnvelope,
      openBlocks: Object.freeze(openBlocks.map((block) => Object.freeze({ ...block }))),
      lastWriteAtMonotonic,
      semanticBlockCount,
      terminalWritten,
    })

  const stopHeartbeat = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const closeHeartbeat = (): void => {
    heartbeatStopped = true
    stopHeartbeat()
  }
  const armHeartbeat = (delay = heartbeat?.intervalMs ?? 0): void => {
    if (!heartbeat || heartbeat.intervalMs <= 0 || state !== "open" || heartbeatSuspended || heartbeatStopped) return
    stopHeartbeat()
    timer = setTimeout(tickHeartbeat, delay)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }
  const tickHeartbeat = (): void => {
    timer = undefined
    if (!heartbeat || state !== "open" || heartbeatSuspended || heartbeatStopped || heartbeat.clientAbortSignal?.aborted) return
    const now = monotonicNow()
    const heartbeatLedger = Object.freeze({ ...currentLedger(), openBlocks: Object.freeze(pendingOpenBlocks.map((block) => Object.freeze({ ...block }))) })
    const contentDeadlineMs = heartbeat.contentDeadlineMs ?? 0
    // Content-idle is independent of byte/write-idle: upstream pings may keep arriving every few
    // seconds while Claude Code's 300s event watchdog still advances. Check this deadline before
    // the normal forward-idle gate so frequent ping writes cannot postpone escalation forever.
    const contentEscalationDue = contentDeadlineMs > 0 && now - lastContentDeltaAtMonotonic >= contentDeadlineMs
    if (contentEscalationDue) {
      if (pendingOpenBlocks.length > 0 && heartbeat.contentFrame) {
        void write(makeEnvelope(heartbeat.contentFrame(heartbeatLedger), "keepalive", monotonicNow())).finally(() => armHeartbeat())
        return
      }
      // Fixed anchor@0 is valid only before any real block has completed. After the first
      // committed block, a no-open window needs the future monotone index allocator; reusing
      // index 0 would make the SDK reorder content. Until that design lands, stay on ping.
      if (pendingOpenBlocks.length === 0 && semanticBlockCount === 0 && heartbeat.injectContentScaffold && !contentScaffoldAttempted) {
        contentScaffoldAttempted = true
        void heartbeat
          .injectContentScaffold()
          .then((injected) => {
            if (!injected) contentScaffoldAttempted = false
            else lastContentDeltaAtMonotonic = monotonicNow()
          })
          .catch(() => {
            contentScaffoldAttempted = false
          })
          .finally(() => armHeartbeat())
        return
      }
    }
    const elapsed = now - lastWriteAtMonotonic
    if (elapsed < heartbeat.intervalMs) {
      armHeartbeat(
        Math.min(
          heartbeat.intervalMs - elapsed,
          contentDeadlineMs > 0 ? Math.max(1, contentDeadlineMs - (now - lastContentDeltaAtMonotonic)) : Number.POSITIVE_INFINITY,
        ),
      )
      return
    }
    if (heartbeat.injectScaffold && pendingOpenBlocks.length === 0 && semanticBlockCount === 0 && !scaffoldAttempted) {
      scaffoldAttempted = true
      void heartbeat
        .injectScaffold()
        .then((injected) => {
          if (!injected) scaffoldAttempted = false
        })
        .catch(() => {
          scaffoldAttempted = false
        })
        .finally(() => armHeartbeat())
      return
    }
    void write(makeEnvelope(heartbeat.frame(heartbeatLedger), "keepalive", monotonicNow())).finally(() => armHeartbeat())
  }

  const applyPendingFrame = (entry: DeliveryFrame): void => {
    const payload = parsePayload(entry.frame.data)
    if (!payload) return
    if (payload.type === "content_block_start" && typeof payload.index === "number" && typeof payload.content_block?.type === "string") {
      pendingOpenBlocks.push({ index: payload.index, type: payload.content_block.type, synthetic: syntheticKind(entry) === "anchor" })
    }
    if (payload.type === "content_block_stop" && typeof payload.index === "number") {
      pendingOpenBlocks = pendingOpenBlocks.filter((block) => block.index !== payload.index)
    }
  }

  const applyWireFrame = (entry: DeliveryFrame): void => {
    if (entry.provenance.kind === "candidate" && readSyntheticKind(entry.frame) === undefined && isRealContentFrame?.(entry.frame)) {
      hasEmittedRealClientContent = true
    }
    const payload = parsePayload(entry.frame.data)
    if (!payload) return
    if (payload.type === "message_start") messageEnvelope = syntheticKind(entry) === "synthetic-message-start" ? "synthetic" : "real"
    if (payload.type === "content_block_start" && typeof payload.index === "number" && typeof payload.content_block?.type === "string") {
      openBlocks.push({ index: payload.index, type: payload.content_block.type, synthetic: syntheticKind(entry) === "anchor" })
    }
    if (payload.type === "content_block_stop" && typeof payload.index === "number") {
      const closing = openBlocks.find((block) => block.index === payload.index)
      openBlocks = openBlocks.filter((block) => block.index !== payload.index)
      if (closing && !closing.synthetic) semanticBlockCount++
    }
    if (payload.type === "message_stop" || payload.type === "response.completed" || payload.type === "error") terminalWritten = true
  }

  const wireState = options.wireState
  const envelope: WireEnvelopeFactory = Object.freeze({
    real: (frame: ClientFrame): WireWriteSpec => Object.freeze({ kind: "real", frame }),
    anchor: (frame: ClientFrame): WireWriteSpec => Object.freeze({ kind: "anchor", frame }),
    keepalive: (frame: ClientFrame): WireWriteSpec => Object.freeze({ kind: "keepalive", frame }),
  })

  const requireWireState = (): GenerationWireState => {
    if (!wireState) throw new Error("[delivery] generation wire state is not configured for this format")
    return wireState
  }

  const frameForSpec = (spec: WireWriteSpec, source?: LegSource): DeliveryFrame => {
    if (spec.kind === "anchor") {
      const synthetic = parsePayload(spec.frame.data)?.type === "message_start" ? "synthetic-message-start" : "anchor"
      return makeEnvelope(spec.frame, synthetic, monotonicNow())
    }
    if (spec.kind === "keepalive") return makeEnvelope(spec.frame, spec.kind, monotonicNow())
    if (!source) throw new Error("[delivery] cannot write a real frame without an active leg")
    return Object.freeze({
      frame: spec.frame,
      sequence: 0,
      observedAtMonotonic: monotonicNow(),
      provenance: Object.freeze({ kind: "candidate" as const, candidateId: source.candidateId, dispatchId: source.dispatchId }),
    })
  }

  const ownerFailure = <T>(failure: Extract<OwnerResult<T>, { ok: false }>): OwnerResult<T> => Object.freeze(failure)
  const ownerSuccess = <T>(value: T): OwnerResult<T> => Object.freeze({ ok: true, value })
  const recordPartialDelivery = (operation: OwnerOperation, cause: "client-gone" | "wire-error"): void => {
    const detail = Object.freeze({ operation, cause, committed: true as const })
    options.recordWirePartialDelivery?.(detail)
  }

  const finalizeSinkOnce = (): Promise<void> => {
    finalized ??= Promise.resolve().then(async () => {
      sink.close?.()
      await sink.finalize?.()
    })
    return finalized
  }

  const finalizeAfterClientGone = async (): Promise<void> => {
    if (finishReason === "client-gone" && finalized) return finalized
    state = "terminating"
    finishReason ??= "client-gone"
    closeHeartbeat()
    state = "closed"
    await finalizeSinkOnce()
  }

  const ownerUnavailable = <T>(): OwnerResult<T> | undefined => {
    if (wireTorn) return ownerFailure<T>({ ok: false, reason: "wire-torn", committed: false })
    if (state === "open") return undefined
    if (finishReason === "client-gone") return ownerFailure<T>({ ok: false, reason: "client-gone", committed: false })
    return ownerFailure<T>({ ok: false, reason: "session-terminating", committed: false })
  }

  const closeUnavailable = <T>(): OwnerResult<T> | undefined => {
    if (state === "open" || wireTorn) return undefined
    if (finishReason === "client-gone") return ownerFailure<T>({ ok: false, reason: "client-gone", committed: false })
    return ownerFailure<T>({ ok: false, reason: "session-terminating", committed: false })
  }

  const commitPublishedAnchorClose = (entry: DeliveryFrame): void => {
    if (syntheticKind(entry) !== "anchor") return
    const currentWireState = wireState
    const index = currentWireState?.openAnchorIndex
    const payload = parsePayload(entry.frame.data)
    if (!currentWireState || index === undefined || payload?.type !== "content_block_stop" || payload.index !== index) return
    currentWireState.openAnchorIndex = undefined
    if (options.legacyAnchorMirror) options.legacyAnchorMirror.anchorClosed = true
  }

  const writeCommittedBatch = async (
    specs: ReadonlyArray<WireWriteSpec>,
    operation: OwnerOperation,
    source: LegSource | undefined,
    commit: () => void,
  ): Promise<OwnerResult<true>> => {
    if (specs.length === 0) throw new Error("[delivery] owner build produced no wire frames")
    let committed = false
    try {
      // All frame/provenance conversion finishes before C9 and before any external wire write.
      const entries = specs.map((spec) => frameForSpec(spec, source))
      // C9 is the synchronous boundary immediately before the first external wire write.
      commit()
      committed = true
      if (operation === "allocate-anchor" || operation === "allocate-real-block") {
        const onCommittedAllocationForTests = deliverySessionTestHooks?.onCommittedAllocation
        if (onCommittedAllocationForTests) await onCommittedAllocationForTests(operation)
      }
      for (const entry of entries) {
        applyPendingFrame(entry)
        if (operation === "publish-recovery-batch") await deliverySessionTestHooks?.onWrite?.(entry)
        await writeToSink(sink, entry)
        applyWireFrame(entry)
        if (operation === "publish-recovery-batch") commitPublishedAnchorClose(entry)
        const writtenAt = monotonicNow()
        lastWriteAtMonotonic = writtenAt
        if (isContentDelta(entry.frame)) lastContentDeltaAtMonotonic = writtenAt
        writeCount++
      }
      return ownerSuccess(true)
    } catch (error) {
      if (classifyStreamError(error) === "client-abort") {
        if (committed) recordPartialDelivery(operation, "client-gone")
        await finalizeAfterClientGone()
        return ownerFailure(committed ? { ok: false, reason: "client-gone", committed: true } : { ok: false, reason: "client-gone", committed: false })
      }
      if (committed) {
        wireTorn = true
        recordPartialDelivery(operation, "wire-error")
      }
      consola.error("[delivery] owner wire write failed", error)
      throw new DeliveryOwnerError(error, committed)
    }
  }

  const writeAllocationFrames = async (
    specs: ReadonlyArray<WireWriteSpec>,
    reservation: WireIndexReservation<number | WireBlockMapping>,
    operation: "allocate-anchor" | "allocate-real-block",
    source?: LegSource,
    onCommit?: () => void,
  ): Promise<OwnerResult<true>> => {
    if (specs.length === 0) {
      reservation.rollback()
      throw new Error("[delivery] allocation build produced no wire frames")
    }
    try {
      return await writeCommittedBatch(specs, operation, source, () => {
        reservation.commit()
        onCommit?.()
      })
    } catch (error) {
      if (error instanceof DeliveryOwnerError && !error.committed) reservation.rollback()
      throw error
    }
  }

  const allocationPort: WireBlockAllocationPort = {
    wireState,
    allocateAndWriteAnchor: (build) =>
      serializer.enqueue(async () => {
        const unavailable = ownerUnavailable<number>()
        if (unavailable) return unavailable
        const current = requireWireState()
        const reservation = current.allocator.reserveAnchor()
        let specs: ReadonlyArray<WireWriteSpec>
        try {
          specs = build({ wireIndex: reservation.value, envelope })
        } catch (error) {
          reservation.rollback()
          throw error
        }
        const written = await writeAllocationFrames(specs, reservation, "allocate-anchor", current.activeLeg?.source, () => {
          current.openAnchorIndex = reservation.value
          if (options.legacyAnchorMirror) options.legacyAnchorMirror.anchorClosed = false
        })
        if (!written.ok) return written
        return ownerSuccess(reservation.value)
      }),
    withAllocatedRealBlock: (upstreamIndex, build) =>
      serializer.enqueue(async () => {
        const unavailable = ownerUnavailable<WireBlockMapping>()
        if (unavailable) return unavailable
        const current = requireWireState()
        if (!current.activeLeg) throw new Error("[delivery] cannot allocate a real block without an active leg")
        const reservation = current.allocator.reserveRealBlock(upstreamIndex)
        let specs: ReadonlyArray<WireWriteSpec>
        try {
          specs = build({ mapping: reservation.value, envelope })
        } catch (error) {
          reservation.rollback()
          throw error
        }
        const written = await writeAllocationFrames(specs, reservation, "allocate-real-block", current.activeLeg.source, () => {
          const perLeg = current.mappings.get(reservation.value.leg) ?? new Map<number, WireBlockMapping>()
          perLeg.set(upstreamIndex, reservation.value)
          current.mappings.set(reservation.value.leg, perLeg)
        })
        if (!written.ok) return written
        return ownerSuccess(reservation.value)
      }),
    publishRecoveryBatch: (source, build) =>
      serializer.enqueue(async () => {
        const unavailable = ownerUnavailable<"published">()
        if (unavailable) return unavailable
        let specs: ReadonlyArray<WireWriteSpec>
        try {
          specs = build({ envelope, openAnchorIndex: wireState?.openAnchorIndex })
          if (specs.length === 0) throw new Error("[delivery] recovery batch build produced no wire frames")
          await deliverySessionTestHooks?.onBeforeRecoveryBatchCommit?.()
        } catch (error) {
          throw new DeliveryOwnerError(error, false)
        }
        const written = await writeCommittedBatch(specs, "publish-recovery-batch", source, () => {})
        if (!written.ok) return written
        return ownerSuccess("published" as const)
      }),
    beginLeg: (kind, source) =>
      serializer.enqueue(async () => {
        const unavailable = ownerUnavailable<LegToken>()
        if (unavailable) return unavailable
        const onBeginLegForTests = deliverySessionTestHooks?.onBeginLeg
        if (onBeginLegForTests) {
          try {
            await onBeginLegForTests(kind)
          } catch (error) {
            throw new DeliveryOwnerError(error, false)
          }
        }
        const current = requireWireState()
        const token = current.allocator.beginLeg(kind, source)
        current.activeLeg = Object.freeze({
          token,
          kind,
          source: Object.freeze({ candidateId: source.candidateId, dispatchId: source.dispatchId }),
        })
        current.legSources.set(token, current.activeLeg.source)
        current.mappings.set(token, new Map())
        return ownerSuccess(token)
      }),
    closeOpenAnchor: (buildStop, mode) =>
      serializer.enqueue(async () => {
        const unavailable = closeUnavailable<"closed" | "none">()
        if (unavailable) return unavailable
        const current = requireWireState()
        try {
          await deliverySessionTestHooks?.onCloseAnchor?.()
          if (current.openAnchorIndex === undefined) return ownerSuccess("none" as const)
          if (mode === "terminal") closeHeartbeat()
          const index = current.openAnchorIndex
          const entry = frameForSpec(buildStop(index, envelope))
          applyPendingFrame(entry)
          await writeToSink(sink, entry)
          applyWireFrame(entry)
          current.openAnchorIndex = undefined
          if (options.legacyAnchorMirror) options.legacyAnchorMirror.anchorClosed = true
          const writtenAt = monotonicNow()
          lastWriteAtMonotonic = writtenAt
          if (isContentDelta(entry.frame)) lastContentDeltaAtMonotonic = writtenAt
          writeCount++
          return ownerSuccess("closed" as const)
        } catch (error) {
          if (classifyStreamError(error) === "client-abort") {
            recordPartialDelivery(mode === "terminal" ? "close-anchor-terminal" : "close-anchor-before-real", "client-gone")
            await finalizeAfterClientGone()
            return ownerFailure({ ok: false, reason: "client-gone", committed: true })
          }
          wireTorn = true
          recordPartialDelivery(mode === "terminal" ? "close-anchor-terminal" : "close-anchor-before-real", "wire-error")
          consola.error("[delivery] owner anchor close failed", error)
          throw new DeliveryOwnerError(error, true)
        }
      }),
    writeBlockFrame: (leg, upstreamIndex, frame) =>
      serializer.enqueue(async () => {
        const unavailable = ownerUnavailable<"written">()
        if (unavailable) return unavailable
        const current = requireWireState()
        const mapping = current.mappings.get(leg)?.get(upstreamIndex)
        if (!mapping) throw new Error(`[delivery] no mapping for leg ${String(leg)} upstream block ${upstreamIndex}`)
        const source = current.legSources.get(leg)
        if (!source) throw new Error("[delivery] block mapping has no leg provenance")
        const entry = frameForSpec(envelope.real(mapping.remap(frame)), source)
        try {
          applyPendingFrame(entry)
          await writeToSink(sink, entry)
          applyWireFrame(entry)
          const writtenAt = monotonicNow()
          lastWriteAtMonotonic = writtenAt
          if (isContentDelta(entry.frame)) lastContentDeltaAtMonotonic = writtenAt
          writeCount++
          if (parsePayload(frame.data)?.type === "content_block_stop") current.mappings.get(leg)?.delete(upstreamIndex)
          return ownerSuccess("written" as const)
        } catch (error) {
          if (classifyStreamError(error) === "client-abort") {
            recordPartialDelivery("write-block-frame", "client-gone")
            await finalizeAfterClientGone()
            return ownerFailure({ ok: false, reason: "client-gone", committed: true })
          }
          wireTorn = true
          recordPartialDelivery("write-block-frame", "wire-error")
          consola.error("[delivery] owner block write failed", error)
          throw new DeliveryOwnerError(error, true)
        }
      }),
  }

  const clientSink: OwnerRawSink = {
    write: async (frame) => {
      if (!winnerCandidateId) winnerCandidateId = "sole"
      await write(winnerSource ? candidateDeliveryFrame(frame, winnerSource, monotonicNow()) : asDeliveryFrame(frame))
    },
    writeSynthetic: (frame) => write(makeEnvelope(frame, "synthetic", monotonicNow())),
    writeKeepalive: (frame) => write(makeEnvelope(frame, "keepalive", monotonicNow())),
    writeSyntheticEnvelope: (frame) => write(makeEnvelope(frame, "synthetic-message-start", monotonicNow())),
    writeAnchor: (frame) => write(makeEnvelope(frame, "anchor", monotonicNow())),
    freezeHeartbeat: stopHeartbeat,
    suspendHeartbeat() {
      heartbeatSuspended = true
      stopHeartbeat()
    },
    resumeHeartbeat() {
      if (!heartbeatSuspended || state !== "open" || heartbeatStopped) return
      heartbeatSuspended = false
      lastWriteAtMonotonic = monotonicNow()
      armHeartbeat()
    },
    close: closeHeartbeat,
  }

  const session: DownstreamDeliverySession = {
    identity,
    get hasEmittedRealClientContent() {
      return hasEmittedRealClientContent
    },
    get snapshot() {
      return Object.freeze({
        state,
        ...(winnerCandidateId && { winnerCandidateId }),
        ledger: currentLedger(),
        upstreamRounds: Object.freeze([...upstreamRounds]),
        writeCount,
      })
    },
    clientSink,
    allocationPort,
    async writeScaffold(frames) {
      for (const entry of frames) await write(entry)
    },
    noteWinner(source) {
      winnerCandidateId = source.candidateId
      winnerSource = Object.freeze({ candidateId: source.candidateId, dispatchId: source.dispatchId })
    },
    noteUpstreamRoundEnded(reason) {
      upstreamRounds.push(reason)
    },
    noteUpstreamRoundStarted(candidateId) {
      upstreamRounds.push(candidateId)
    },
    async terminate(command) {
      if (state !== "open") return
      state = "terminating"
      finishReason ??= command.kind === "client-aborted" ? "client-gone" : "session-terminating"
      closeHeartbeat()
      const frames = command.kind === "client-aborted" ? [] : (command.frames ?? [])
      for (const entry of frames) await write(entry, true)
      state = "closed"
      await finalizeSinkOnce()
    },
  }

  clientSink.finalize = () => session.terminate({ kind: "complete" })
  deliveryBySink.set(clientSink, session)
  deliveryByAllocationPort.set(allocationPort, session)
  deliverySessionObserverForTests?.(session)
  armHeartbeat()
  return session
}

function candidateDeliveryFrame(frame: DeliveryFrame["frame"], source: LegSource, observedAtMonotonic: number): DeliveryFrame {
  return Object.freeze({
    frame,
    sequence: 0,
    observedAtMonotonic,
    provenance: Object.freeze({ kind: "candidate" as const, candidateId: source.candidateId, dispatchId: source.dispatchId }),
  })
}

function makeEnvelope(frame: DeliveryFrame["frame"], synthetic: DeliverySyntheticKind, observedAtMonotonic: number): DeliveryFrame {
  return Object.freeze({
    frame,
    sequence: 0,
    observedAtMonotonic,
    provenance: Object.freeze({ kind: "synthetic" as const, syntheticKind: synthetic }),
  })
}

function asDeliveryFrame(value: DeliveryFrame | DeliveryFrame["frame"]): DeliveryFrame {
  return "frame" in value ? value : (
      Object.freeze({
        frame: value,
        sequence: 0,
        observedAtMonotonic: 0,
        provenance: Object.freeze({ kind: "candidate" as const, candidateId: "legacy", dispatchId: "legacy" }),
      })
    )
}

async function writeToSink(sink: OwnerRawSink, entry: DeliveryFrame): Promise<void> {
  switch (syntheticKind(entry)) {
    case "anchor": {
      await (sink.writeAnchor ?? sink.write)(entry.frame)
      return
    }
    case "keepalive": {
      await (sink.writeKeepalive ?? sink.write)(entry.frame)
      return
    }
    case "synthetic-message-start": {
      await (sink.writeSyntheticEnvelope ?? sink.write)(entry.frame)
      return
    }
    case "synthetic": {
      await (sink.writeSynthetic ?? sink.write)(entry.frame)
      return
    }
    default: {
      await sink.write(entry.frame)
    }
  }
}

function syntheticKind(entry: DeliveryFrame): DeliverySyntheticKind | undefined {
  return entry.provenance.kind === "synthetic" ? (entry.provenance.syntheticKind as DeliverySyntheticKind) : undefined
}

function isContentDelta(frame: DeliveryFrame["frame"]): boolean {
  return parsePayload(frame.data)?.type === "content_block_delta"
}

function parsePayload(data: string | undefined): { type?: string; index?: number; content_block?: { type?: string } } | undefined {
  if (!data) return undefined
  try {
    return JSON.parse(data) as { type?: string; index?: number; content_block?: { type?: string } }
  } catch {
    // Non-JSON or typeless frames still count as actual wire writes, but they cannot advance a
    // content-block ledger without protocol structure.
    return undefined
  }
}
