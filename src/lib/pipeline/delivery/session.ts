/**
 * Generation-owned downstream delivery session.
 *
 * This first cut centralizes the unique wire serializer and derives block state only from writes that
 * actually reach the injected ClientSink. It deliberately has no upstream attempt/candidate dependency;
 * round notifications are diagnostic no-ops for wire state. Heartbeat and terminal fencing build on this
 * owner in the next task.
 */

import type { ClientSink } from "../types"
import type {
  //
  ClientBlockLedger,
  DeliveredOpenBlock,
  DeliveryFrame,
  DeliverySnapshot,
  DeliverySyntheticKind,
  DeliveryHeartbeat,
  DeliveryTerminalCommand,
} from "./types"

import { createDeliverySerializer } from "./serializer"

/** Construction options for one generation delivery. */
export interface CreateDownstreamDeliverySessionOptions {
  readonly sink: ClientSink
  readonly monotonicNow?: () => number
  readonly heartbeat?: DeliveryHeartbeat
}

/** Generation-scoped delivery port consumed by the retry/competition engine. */
export interface DownstreamDeliverySession {
  readonly identity: symbol
  readonly snapshot: DeliverySnapshot
  readonly clientSink: ClientSink
  writeScaffold(frames: ReadonlyArray<DeliveryFrame>): Promise<void>
  commitWinnerBlock(candidateId: string, frames: ReadonlyArray<DeliveryFrame | DeliveryFrame["frame"]>): Promise<void>
  writeWinnerFrame(candidateId: string, frame: DeliveryFrame | DeliveryFrame["frame"]): Promise<void>
  noteUpstreamRoundEnded(reason: string): void
  noteUpstreamRoundStarted(candidateId: string): void
  terminate(command: DeliveryTerminalCommand): Promise<void>
}

const deliveryBySink = new WeakMap<ClientSink, DownstreamDeliverySession>()

/** Resolve the generation-owned delivery behind a production delivery sink. */
export function getDownstreamDeliverySession(sink: ClientSink): DownstreamDeliverySession | undefined {
  return deliveryBySink.get(sink)
}

/** Create a delivery session whose identity and ledger outlive every upstream round. */
export function createDownstreamDeliverySession(options: CreateDownstreamDeliverySessionOptions): DownstreamDeliverySession {
  const { sink } = options
  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance)
  const heartbeat = options.heartbeat
  const serializer = createDeliverySerializer()
  const identity = Symbol("downstreamDeliverySession")
  let state: DeliverySnapshot["state"] = "open"
  let winnerCandidateId: string | undefined
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

  const write = async (entry: DeliveryFrame, allowTerminating = false): Promise<void> => {
    await serializer.enqueue(async () => {
      if (state !== "open" && (!allowTerminating || state !== "terminating")) return
      applyPendingFrame(entry)
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
    if (heartbeat.injectScaffold && pendingOpenBlocks.length === 0 && !scaffoldAttempted) {
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

  const clientSink: ClientSink = {
    write: async (frame) => {
      if (!winnerCandidateId) winnerCandidateId = "sole"
      await write(asDeliveryFrame(frame))
    },
    writeSynthetic: (frame) => write(makeEnvelope(frame, "synthetic", monotonicNow())),
    writeKeepalive: (frame) => write(makeEnvelope(frame, "keepalive", monotonicNow())),
    writeSyntheticEnvelope: (frame) => write(makeEnvelope(frame, "synthetic-message-start", monotonicNow())),
    writeAnchor: (frame) => write(makeEnvelope(frame, "anchor", monotonicNow())),
    freezeHeartbeat: closeHeartbeat,
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
    async writeScaffold(frames) {
      for (const entry of frames) await write(entry)
    },
    async commitWinnerBlock(candidateId, frames) {
      if (winnerCandidateId && winnerCandidateId !== candidateId) throw new Error(`[delivery] winner is ${winnerCandidateId}, not ${candidateId}`)
      winnerCandidateId = candidateId
      for (const entry of frames) await write(asDeliveryFrame(entry))
    },
    async writeWinnerFrame(candidateId, frame) {
      if (winnerCandidateId !== candidateId) throw new Error(`[delivery] winner is ${winnerCandidateId ?? "not selected"}, not ${candidateId}`)
      await write(asDeliveryFrame(frame))
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
      closeHeartbeat()
      const frames = command.kind === "client-aborted" ? [] : (command.frames ?? [])
      for (const entry of frames) await write(entry, true)
      state = "closed"
      sink.close?.()
      await sink.finalize?.()
    },
  }

  clientSink.finalize = () => session.terminate({ kind: "complete" })
  deliveryBySink.set(clientSink, session)
  armHeartbeat()
  return session
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

async function writeToSink(sink: ClientSink, entry: DeliveryFrame): Promise<void> {
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
