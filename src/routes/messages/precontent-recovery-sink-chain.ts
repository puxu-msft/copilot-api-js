import type {
  //
  AnchorHooks,
  AnchorState,
  ClientFrame,
  ClientSink,
  RecoveryBatchBuild,
  WireEnvelopeFactory,
} from "~/lib/pipeline/types"

import {
  //
  makeReconcilingSink,
  reconcileLiveFrame,
} from "~/lib/anthropic/live-reconcile"
import {
  //
  getDownstreamDeliverySession,
  type DownstreamDeliverySession,
} from "~/lib/pipeline/delivery/session"
import { createRecoverySinkSupervisor } from "~/lib/pipeline/generation/recovery-sink-supervisor"

export interface PreContentRecoverySinkChain {
  readonly sink: ClientSink
  readonly rawSink: ClientSink
  readonly liveSink: ClientSink
  readonly deliverySession: DownstreamDeliverySession
  settleFinal(): Promise<void>
}

export type StagedRecoveryWrite = Readonly<{ readonly frame: ClientFrame }>

export interface StagedDirectRecoveryBatch {
  readonly state: AnchorState
  readonly entries: ReadonlyArray<StagedRecoveryWrite>
  build(envelope: WireEnvelopeFactory): RecoveryBatchBuild
}

function isRecoveryAnchorTerminus(frame: ClientFrame): boolean {
  if (typeof frame.data !== "string") return false
  try {
    const type = (JSON.parse(frame.data) as { type?: unknown }).type
    return type === "content_block_start" || type === "message_delta" || type === "message_stop" || type === "error"
  } catch {
    return false
  }
}

/** Stage a complete direct recovery without reading owner-owned anchor state. */
export function stageDirectRecoveryBatch(
  frames: ReadonlyArray<ClientFrame>,
  anchorState: AnchorState,
  anchorHooks: AnchorHooks | undefined,
): StagedDirectRecoveryBatch {
  const state: AnchorState = { ...anchorState }
  const entries: Array<StagedRecoveryWrite> = []
  let needsAnchorClose = state.anchorBlockOpen && !state.anchorClosed
  let closeAnchorBeforeBatch = false
  for (const frame of frames) {
    const reconciled = reconcileLiveFrame(frame, state, anchorHooks)
    if (needsAnchorClose && reconciled.some((entry) => isRecoveryAnchorTerminus(entry))) {
      if (!anchorHooks) throw new Error("[Anthropic:v4] open anchor lacks reconciliation hooks")
      closeAnchorBeforeBatch = true
      needsAnchorClose = false
    }
    entries.push(...reconciled.map((entry) => ({ frame: entry })))
  }
  if (needsAnchorClose) throw new Error("[Anthropic:v4] recovery batch ended without closing the open anchor")
  return {
    state,
    entries,
    build: (envelope) => ({
      specs: entries.map((entry) => envelope.real(entry.frame)),
      ...(closeAnchorBeforeBatch
        && anchorHooks && {
          closeOpenAnchorBefore: (index, ownerEnvelope) => ownerEnvelope.anchor(anchorHooks.stopFrame(index)),
        }),
    }),
  }
}

function liveReconcilingSink(
  sink: ClientSink,
  anchorHooks: AnchorHooks | undefined,
  anchorState: AnchorState,
  deliverySession: DownstreamDeliverySession,
): ClientSink {
  return makeReconcilingSink(sink, anchorState, anchorHooks, deliverySession.allocationPort)
}

/** Build the one request-owned raw→supervisor→rewriting sink chain. */
export function createPreContentRecoverySinkChain(
  rawSink: ClientSink,
  anchorHooks: AnchorHooks | undefined,
  anchorState: AnchorState,
): PreContentRecoverySinkChain {
  const deliverySession = getDownstreamDeliverySession(rawSink)
  if (!deliverySession) throw new Error("[Anthropic:v4] raw delivery sink has no generation-owned session")
  const supervisor = createRecoverySinkSupervisor(rawSink)
  return {
    sink: supervisor.sink,
    rawSink,
    liveSink: liveReconcilingSink(supervisor.sink, anchorHooks, anchorState, deliverySession),
    deliverySession,
    settleFinal: () => supervisor.settleFinal(),
  }
}
