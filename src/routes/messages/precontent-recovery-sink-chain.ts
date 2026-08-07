import type {
  //
  AnchorHooks,
  AnchorState,
  ClientSink,
} from "~/lib/pipeline/types"

import { makeReconcilingSink } from "~/lib/anthropic/live-reconcile"
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
