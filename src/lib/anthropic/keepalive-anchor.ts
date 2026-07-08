import type { ServerSentEventMessage } from "fetch-event-stream"

import { anthropicSseFrame } from "./sse-frame"

/**
 * Reserved index of the synthetic empty-text keepalive ANCHOR block injected in buffered
 * pre-commit (spec 2026-07-08-buffered-keepalive-empty-text-anchor). The anchor occupies
 * index 0; all real content blocks flush at index+1 (see remapAnthropicBlockIndex).
 */
export const ANCHOR_INDEX = 0

/** `content_block_start` opening the empty-text anchor block (lights the sink openBlock={0,text}). */
export function anchorStartFrame(): ServerSentEventMessage {
  return anthropicSseFrame({
    type: "content_block_start",
    index: ANCHOR_INDEX,
    content_block: { type: "text", text: "" },
  })
}

/** Empty `text_delta` on the anchor block — the frame that actually resets CC's 300s watchdog. */
export function anchorDeltaFrame(): ServerSentEventMessage {
  return anthropicSseFrame({
    type: "content_block_delta",
    index: ANCHOR_INDEX,
    delta: { type: "text_delta", text: "" },
  })
}

/** `content_block_stop` closing the anchor at commit / terminal failure (empty text — known-benign). */
export function anchorStopFrame(): ServerSentEventMessage {
  return anthropicSseFrame({ type: "content_block_stop", index: ANCHOR_INDEX })
}
