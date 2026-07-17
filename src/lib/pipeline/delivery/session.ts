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
} from "./types"

import { createDeliverySerializer } from "./serializer"

/** Construction options for one generation delivery. */
export interface CreateDownstreamDeliverySessionOptions {
  readonly sink: ClientSink
  readonly monotonicNow?: () => number
}

/** Generation-scoped delivery port consumed by the retry/competition engine. */
export interface DownstreamDeliverySession {
  readonly identity: symbol
  readonly snapshot: DeliverySnapshot
  writeScaffold(frames: ReadonlyArray<DeliveryFrame>): Promise<void>
  commitWinnerBlock(candidateId: string, frames: ReadonlyArray<DeliveryFrame | DeliveryFrame["frame"]>): Promise<void>
  writeWinnerFrame(candidateId: string, frame: DeliveryFrame | DeliveryFrame["frame"]): Promise<void>
  noteUpstreamRoundEnded(reason: string): void
  noteUpstreamRoundStarted(candidateId: string): void
}

/** Create a delivery session whose identity and ledger outlive every upstream round. */
export function createDownstreamDeliverySession(options: CreateDownstreamDeliverySessionOptions): DownstreamDeliverySession {
  const { sink } = options
  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance)
  const serializer = createDeliverySerializer()
  const identity = Symbol("downstreamDeliverySession")
  const state: DeliverySnapshot["state"] = "open"
  let winnerCandidateId: string | undefined
  let messageEnvelope: ClientBlockLedger["messageEnvelope"] = "none"
  let openBlocks: Array<DeliveredOpenBlock> = []
  let lastWriteAtMonotonic = 0
  let semanticBlockCount = 0
  let terminalWritten = false
  let writeCount = 0
  const upstreamRounds: Array<string> = []

  const write = async (entry: DeliveryFrame): Promise<void> => {
    await serializer.enqueue(async () => {
      await writeToSink(sink, entry)
      applyWireFrame(entry)
      lastWriteAtMonotonic = monotonicNow()
      writeCount++
    })
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

  return {
    identity,
    get snapshot() {
      return Object.freeze({
        state,
        ...(winnerCandidateId && { winnerCandidateId }),
        ledger: Object.freeze({
          messageEnvelope,
          openBlocks: Object.freeze(openBlocks.map((block) => Object.freeze({ ...block }))),
          lastWriteAtMonotonic,
          semanticBlockCount,
          terminalWritten,
        }),
        upstreamRounds: Object.freeze([...upstreamRounds]),
        writeCount,
      })
    },
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
  }
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
