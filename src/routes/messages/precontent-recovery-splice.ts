import type {
  //
  AnchorHooks,
  AnchorState,
  ClientFrame,
  ClientSink,
} from "~/lib/pipeline/types"

import { makeReconcilingSink } from "~/lib/anthropic/live-reconcile"

/**
 * Write one fresh recovery-attempt frame into an already-committed client stream.
 * Ping mode has no anchor hooks and remains byte-identical; synthetic-prelude modes reuse the existing
 * live reconcile decorator for duplicate message_start removal, anchor close-off routing, and index remapping.
 */
export async function spliceFreshAttemptFrame(
  frame: ClientFrame,
  sink: ClientSink,
  anchorState: AnchorState,
  anchorHooks: AnchorHooks | undefined,
): Promise<void> {
  if (!anchorHooks) {
    await sink.write(frame)
    return
  }

  await makeReconcilingSink(sink, anchorState, anchorHooks).write(frame)
}
