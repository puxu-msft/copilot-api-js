/**
 * The Anthropic delivery profile's indexed-block builders.
 *
 * Assembly, not new logic: every frame here comes from `anthropic/keepalive-anchor.ts`, which
 * already owns the exact bytes and has goldens proving them. This module's only job is to expose
 * them behind {@link AnthropicIndexedBuilders} so the owner can call them without importing a
 * concrete codec — the delivery layer depends on the narrow port and the format side supplies the
 * knowledge (RFC design §3.3).
 *
 * There is no sibling module of "common" builders, on purpose. Terminal / error / done frames are
 * the per-format `DeliveryProtocolAdapter` and keepalive frames are `DeliveryHeartbeat.frame`; both
 * already exist for all four formats. See the note on {@link AnthropicIndexedBuilders}.
 *
 * Not wired into any production root — the owner that uses this is published in Commit 4.
 */

import {
  //
  anchorDeltaFrame,
  anchorStartFrame,
  anchorStopFrame,
  remapAnthropicBlockIndex,
} from "~/lib/anthropic/keepalive-anchor"

import type { AnthropicIndexedBuilders } from "./capability"

export function createAnthropicIndexedBuilders(): AnthropicIndexedBuilders {
  return {
    buildAnchorStart: (wireIndex) => anchorStartFrame(wireIndex),
    buildAnchorDelta: (wireIndex) => anchorDeltaFrame(wireIndex),
    buildAnchorStop: (wireIndex) => anchorStopFrame(wireIndex),

    remapToWireIndex(frame, wireIndex, upstreamIndex) {
      // An identity mapping returns the ORIGINAL object rather than a re-serialized equal one, which
      // keeps `===` meaningful for callers that compare frames. A block count is NOT equivalent to
      // mapping identity: continuation and recovery legs restart upstream indices even when no
      // synthetic anchor ever opened, so the two indices are compared directly.
      if (wireIndex === upstreamIndex) return frame
      return remapAnthropicBlockIndex(frame, wireIndex - upstreamIndex)
    },
  }
}
